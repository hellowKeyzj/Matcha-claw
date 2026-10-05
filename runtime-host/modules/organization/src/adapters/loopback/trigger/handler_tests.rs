use platform::capability::CapabilityDecisionVerifier;

use std::{
    num::NonZeroU32,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, StartTrigger,
    TeamDefinition, TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::*;

const ROUTE: &str = "/api/team/trigger";
const WEBHOOK_AUTH_ROUTE: &str = "/api/team/webhook-auth";

struct RunningHandler {
    _root: tempfile::TempDir,
    system: foundation::execution::OwnerRuntimeSystem,
    owner: foundation::execution::OwnedTask<()>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    token: WebhookToken,
    organization: crate::OrganizationHandle,
}

impl RunningHandler {
    async fn start() -> Self {
        Self::start_with_facts(None).await
    }

    async fn start_with_facts(facts: Option<OrganizationFacts>) -> Self {
        let root = tempfile::tempdir().expect("test root");
        let mut store = crate::OrganizationStore::open(root.path().join("organization-facts.log"))
            .expect("organization store");
        if let Some(facts) = facts {
            store.replace_facts(facts).expect("seed organization facts");
        }
        let system = foundation::execution::OwnerRuntimeSystem::spawn(Default::default());
        let (organization_module, owner) = crate::spawn_owner(
            &system,
            crate::OrganizationOwnerInput {
                store,
                runtime_directory: Arc::new(EmptyRuntimeDirectory),
                member_introductions: None,
                team_skill_selections: crate::package::TeamSkillSelectionResolver::open(
                    root.path().join("team-skill-selections.json"),
                )
                .expect("team skill selection registry"),
            },
        );
        let verifier = Arc::new(Mutex::new(
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
        ));
        let token = WebhookToken::try_new(&test_webhook_token()).expect("valid webhook token");
        Self {
            _root: root,
            system,
            owner,
            verifier,
            token,
            organization: organization_module.handle().clone(),
        }
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        authorization: Option<&str>,
        body: &str,
    ) -> Value {
        let mut headers = Vec::new();
        if let Some(authorization) = authorization {
            headers.push((
                "authorization".to_owned(),
                format!("Bearer {authorization}"),
            ));
        }
        self.request_with_headers(method, path, headers, body).await
    }

    async fn request_with_headers(
        &self,
        method: &str,
        path: &str,
        headers: Vec<(String, String)>,
        body: &str,
    ) -> Value {
        let response = handle_loopback(
            method.to_owned(),
            path.to_owned(),
            headers,
            body.as_bytes().to_vec(),
            Arc::clone(&self.verifier),
            self.token.clone(),
            self.organization.clone(),
        )
        .await;
        json!({ "status": response.status(), "body": response.body() })
    }

    async fn external_webhook(
        &self,
        path: &str,
        token: Option<&str>,
        idempotency_key: Option<&str>,
        body: &str,
        bearer: bool,
    ) -> Value {
        let mut headers = Vec::new();
        if let (Some(token), true) = (token, bearer) {
            headers.push(("authorization".to_owned(), format!("Bearer {token}")));
        }
        if let (Some(token), false) = (token, bearer) {
            headers.push(("x-matchaclaw-webhook-token".to_owned(), token.to_owned()));
        }
        if let Some(idempotency_key) = idempotency_key {
            headers.push(("x-idempotency-key".to_owned(), idempotency_key.to_owned()));
        }
        self.request_with_headers("POST", path, headers, body).await
    }

    async fn stop(mut self) {
        self.owner.cancel();
        let _ = self.owner.join().await;
        let _ = self.system.cancel_and_join().await;
    }
}

struct EmptyRuntimeDirectory;

impl crate::OrganizationRuntimeDirectory for EmptyRuntimeDirectory {
    fn team_runtime_for_endpoint(
        &self,
        _endpoint: &crate::RuntimeEndpointReference,
    ) -> Option<Arc<dyn crate::OrganizationNativeRuntime>> {
        None
    }

    fn open_claw_runtime(&self) -> Option<Arc<dyn crate::OrganizationNativeRuntime>> {
        None
    }
}

#[tokio::test]
async fn localhost_auth_request_returns_the_sealed_persisted_projection() {
    let server = RunningHandler::start().await;
    let body = r#"{}"#;
    let response = server
        .request("POST", WEBHOOK_AUTH_ROUTE, Some(&decision()), body)
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
    assert!(!response.to_string().contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn localhost_auth_route_requires_post_authorization_and_empty_json_object() {
    let server = RunningHandler::start().await;

    let response = server
        .request("POST", WEBHOOK_AUTH_ROUTE, None, r#"{}"#)
        .await;
    assert_eq!(response["status"], 401);

    let response = server
        .request(
            "POST",
            WEBHOOK_AUTH_ROUTE,
            Some(&decision()),
            r#"{"action":"auth"}"#,
        )
        .await;
    assert_eq!(response["status"], 400);

    let response = server
        .request("GET", WEBHOOK_AUTH_ROUTE, Some(&decision()), r#"{}"#)
        .await;
    assert_eq!(response["status"], 404);

    server.stop().await;
}

#[tokio::test]
async fn trigger_management_rejects_auth_without_a_compatibility_fallback() {
    let server = RunningHandler::start().await;
    let response = server
        .request(
            "POST",
            ROUTE,
            Some(&trigger_decision()),
            r#"{"action":"auth"}"#,
        )
        .await;

    assert_eq!(response["status"], 400);
    server.stop().await;
}

#[tokio::test]
async fn external_webhook_accepts_native_token_and_returns_accepted_without_body_projection() {
    let server = RunningHandler::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let body = r#"{"token":"private-body-secret","message":"ignored"}"#;
    let response = server
        .external_webhook(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some(&test_webhook_token()),
            Some("request:one"),
            body,
            false,
        )
        .await;

    assert_eq!(response["status"], 202);
    assert_eq!(response["body"]["success"], true);
    assert_eq!(response["body"]["runId"], "run:one");
    assert!(!response.to_string().contains("private-body-secret"));
    assert!(!response.to_string().contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn external_webhook_accepts_bearer_token_and_generates_idempotency_when_missing() {
    let server = RunningHandler::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let response = server
        .external_webhook(
            "/api/team-runtime/webhooks/alternate",
            Some(&test_webhook_token()),
            None,
            "{}",
            true,
        )
        .await;

    assert_eq!(response["status"], 202);
    assert_eq!(response["body"]["success"], true);
    assert_eq!(response["body"]["runId"], "run:one");
    assert!(!response.to_string().contains(&test_webhook_token()));

    server.stop().await;
}

#[tokio::test]
async fn external_webhook_rejects_bad_token_and_preserves_not_found_and_duplicate_decisions() {
    let server = RunningHandler::start_with_facts(Some(facts_with_armed_webhook_run())).await;
    let response = server
        .external_webhook(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some("wrong-token"),
            Some("request:unauthorized"),
            "{}",
            false,
        )
        .await;
    assert_eq!(response["status"], 401);

    let response = server
        .external_webhook(
            "/api/team-runtime/webhooks/missing",
            Some(&test_webhook_token()),
            Some("request:not-found"),
            "{}",
            false,
        )
        .await;
    assert_eq!(response["status"], 404);

    let duplicate_facts = facts_with_duplicate_webhook_run();
    let duplicate = RunningHandler::start_with_facts(Some(duplicate_facts)).await;
    let response = duplicate
        .external_webhook(
            "/api/team-runtime/webhooks/private-webhook-path",
            Some(&test_webhook_token()),
            Some("request:duplicate"),
            "{}",
            false,
        )
        .await;
    assert_eq!(response["status"], 409);

    duplicate.stop().await;
    server.stop().await;
}

fn test_webhook_token() -> String {
    format!("mctwh_{}", "a".repeat(64))
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
