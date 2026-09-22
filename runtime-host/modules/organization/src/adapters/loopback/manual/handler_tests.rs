use platform::capability::CapabilityDecisionVerifier;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::*;

struct RunningHandler {
    _root: tempfile::TempDir,
    system: foundation::execution::OwnerRuntimeSystem,
    owner: foundation::execution::OwnedTask<()>,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    organization: crate::OrganizationHandle,
}

impl RunningHandler {
    async fn start() -> Self {
        let root = tempfile::tempdir().expect("test root");
        let store = crate::OrganizationStore::open(root.path().join("organization-facts.log"))
            .expect("organization store");
        let system = foundation::execution::OwnerRuntimeSystem::spawn(Default::default());
        let (organization_module, owner) = crate::spawn_owner(
            &system,
            crate::OrganizationOwnerInput {
                store,
                runtime_directory: Arc::new(EmptyRuntimeDirectory),
                team_skill_selections: crate::package::TeamSkillSelectionResolver::open(
                    root.path().join("team-skill-selections.json"),
                )
                .expect("team skill selection registry"),
            },
        );
        let verifier = Arc::new(Mutex::new(
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
        ));
        Self {
            _root: root,
            system,
            owner,
            verifier,
            organization: organization_module.handle().clone(),
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
        let response = handle_loopback(
            "POST".to_owned(),
            ROUTE.to_owned(),
            headers,
            body.as_bytes().to_vec(),
            Arc::clone(&self.verifier),
            self.organization.clone(),
        )
        .await;
        json!({ "status": response.status(), "body": response.body() })
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
async fn loopback_transport_rejects_nonsealed_or_legacy_requests_without_disclosure() {
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
async fn loopback_transport_rejects_replayed_decisions_without_active_delivery() {
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
