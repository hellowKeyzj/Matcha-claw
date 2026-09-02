use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use environment::{
    CredentialReference, ProviderAccount, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint, ProviderModel,
    ProviderModelCapability, ProviderModelCatalog, ProviderModelReference, ProviderReference,
    ProviderRoute, ProviderRouting, ProviderRoutingCapability, ProviderRoutingRevision,
};
use serde_json::json;

use crate::lifecycle::state_dir::{AgentId, CanonicalStateDir, PrivateAuthProfiles};

use super::*;

const SECRET_CANARY: &str = "synthetic-routing-secret-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    state_dir: CanonicalStateDir,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openclaw-routing-projection-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        let state_dir = CanonicalStateDir::provision(path.join("state")).expect("provision state");
        Self { path, state_dir }
    }

    fn config_path(&self) -> PathBuf {
        self.state_dir.as_path().join("openclaw.json")
    }

    fn store(&self) -> OpenClawConfigStore {
        OpenClawConfigStore::new(self.state_dir.clone())
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn provider(value: &str) -> ProviderKey {
    ProviderKey::try_new(value.into()).expect("valid provider")
}

fn model(value: &str) -> ModelId {
    ModelId::try_new(value.into()).expect("valid model")
}

fn provider_account(
    id: &str,
    provider: &str,
    auth_mode: ProviderAccountAuthMode,
) -> ProviderAccount {
    ProviderAccount::new(
        ProviderAccountId::try_new(id).expect("account identifier"),
        ProviderReference::try_new(format!("provider:{provider}")).expect("provider reference"),
        ProviderAccountRevision::try_new(1).expect("account revision"),
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Provider".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(
                ProviderEndpoint::try_new("https://api.example.com/v1").expect("endpoint"),
            ),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode,
            credential: (!matches!(auth_mode, ProviderAccountAuthMode::Local))
                .then(|| CredentialReference::try_new(format!("credential:v1:{id}")))
                .transpose()
                .expect("credential"),
            created_at: "2026-07-31T10:00:00Z".to_owned(),
            updated_at: "2026-07-31T10:00:00Z".to_owned(),
        })
        .expect("account configuration"),
    )
}

fn provider_model(account: &ProviderAccount, model_id: &str) -> ProviderModel {
    ProviderModel::try_new(
        account.id().clone(),
        model_id,
        vec![ProviderModelCapability::Chat],
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("model")
}

fn desired_routing(account: &ProviderAccount, model_id: &str) -> ProviderRouting {
    ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(1).expect("revision"),
        vec![(
            ProviderRoutingCapability::Chat,
            ProviderRoute::try_new(
                ProviderModelReference::try_new(account.id().clone(), model_id)
                    .expect("model reference"),
                Vec::new(),
                None,
            )
            .expect("route"),
        )],
    )
    .expect("routing")
}

fn route(
    provider_key: &str,
    model_id: &str,
    fallbacks: &[(&str, &str)],
    timeout_ms: Option<u64>,
) -> ModelRoute {
    ModelRoute::new(
        ModelReference::new(provider(provider_key), model(model_id)),
        fallbacks
            .iter()
            .map(|(provider_key, model_id)| {
                ModelReference::new(provider(provider_key), model(model_id))
            })
            .collect(),
        timeout_ms
            .map(PositiveTimeoutMs::try_new)
            .transpose()
            .expect("valid timeout"),
    )
}

#[test]
fn local_account_routing_projects_without_a_private_auth_profile() {
    let root = TestRoot::new();
    let account = provider_account("local-ollama", "ollama", ProviderAccountAuthMode::Local);
    let catalog = ProviderModelCatalog::try_new(vec![provider_model(&account, "llama-3.3")])
        .expect("catalog");
    let routing = desired_routing(&account, "llama-3.3");

    let effect = ProviderRoutingProjection::apply(
        root.state_dir.clone(),
        &[account],
        &catalog,
        &routing,
        1_800_000_000_000,
    )
    .expect("local routing must not require private auth");

    assert!(matches!(
        effect,
        ProviderRoutingProjectionEffect::ConfigurationWritten { changed: true }
    ));
    let document = OpenClawConfigStore::new(root.state_dir.clone())
        .read()
        .expect("read projected config");
    assert_eq!(
        document
            .as_value()
            .pointer("/agents/defaults/model/primary"),
        Some(&json!("ollama-local-ollama/llama-3.3"))
    );
}

#[test]
fn non_local_account_routing_requires_a_private_auth_profile() {
    let root = TestRoot::new();
    let account = provider_account("openai-main", "openai", ProviderAccountAuthMode::ApiKey);
    let catalog =
        ProviderModelCatalog::try_new(vec![provider_model(&account, "gpt-5.6")]).expect("catalog");
    let routing = desired_routing(&account, "gpt-5.6");

    assert_eq!(
        ProviderRoutingProjection::apply(
            root.state_dir.clone(),
            &[account],
            &catalog,
            &routing,
            1_800_000_000_000,
        ),
        Err(ProviderRoutingProjectionError::CredentialUnavailable)
    );
}

#[test]
fn routing_credential_check_uses_projected_provider_key() {
    let root = TestRoot::new();
    let account = provider_account(
        "openai-oauth",
        "openai",
        ProviderAccountAuthMode::OAuthBrowser,
    );
    let catalog =
        ProviderModelCatalog::try_new(vec![provider_model(&account, "gpt-5.6")]).expect("catalog");
    let routing = desired_routing(&account, "gpt-5.6");
    let agent = AgentId::try_new("main".into()).expect("agent");
    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(
                br#"{"version":1,"profiles":{"openai-oauth":{"type":"oauth","provider":"openai-codex","access":"access-token","refresh":"refresh-token","expires":1900000000000}}}"#.to_vec(),
            )
            .expect("legacy provider profile"),
        )
        .expect("store legacy provider profile");

    assert_eq!(
        ProviderRoutingProjection::apply(
            root.state_dir.clone(),
            std::slice::from_ref(&account),
            &catalog,
            &routing,
            1_800_000_000_000,
        ),
        Err(ProviderRoutingProjectionError::CredentialUnavailable)
    );

    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(
                br#"{"version":1,"profiles":{"openai-oauth":{"type":"oauth","provider":"openai","access":"access-token","refresh":"refresh-token","expires":1900000000000}}}"#.to_vec(),
            )
            .expect("canonical provider profile"),
        )
        .expect("store canonical provider profile");

    let effect = ProviderRoutingProjection::apply(
        root.state_dir.clone(),
        std::slice::from_ref(&account),
        &catalog,
        &routing,
        1_800_000_000_000,
    )
    .expect("project routing with canonical provider profile");

    assert!(matches!(
        effect,
        ProviderRoutingProjectionEffect::ConfigurationWritten { changed: true }
    ));
    let document = OpenClawConfigStore::new(root.state_dir.clone())
        .read()
        .expect("read projected config");
    assert_eq!(
        document
            .as_value()
            .pointer("/agents/defaults/model/primary"),
        Some(&json!("openai/gpt-5.6"))
    );
}

#[test]
fn projects_each_capability_to_its_openclaw_field_and_preserves_siblings() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "agents": { "defaults": { "temperature": 0.2 } },
            "messages": { "locale": "en" },
            "gateway": { "port": 18789 }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");
    let routing = CapabilityRouting {
        chat: Some(route(
            "openai",
            "gpt-5.6",
            &[
                ("anthropic", "claude-sonnet-4-6"),
                ("openrouter", "google/gemini-3-pro"),
            ],
            None,
        )),
        image_understand: Some(route("google", "gemini-3-pro", &[], Some(45_000))),
        image_generate: Some(route(
            "matchaclaw-media",
            "custom-media-openai/gpt-image-2",
            &[],
            Some(120_000),
        )),
        video_generate: None,
        music_generate: None,
        tts_provider: Some(provider("elevenlabs")),
    };

    let update = routing.apply(&root.store()).expect("apply routing");
    let document = root.store().read().expect("read config");

    assert!(update.changed);
    assert_eq!(document.get("gateway"), Some(&json!({ "port": 18789 })));
    assert_eq!(
        document.get("agents"),
        Some(&json!({
            "defaults": {
                "temperature": 0.2,
                "model": {
                    "primary": "openai/gpt-5.6",
                    "fallbacks": [
                        "anthropic/claude-sonnet-4-6",
                        "openrouter/google/gemini-3-pro"
                    ]
                },
                "imageModel": {
                    "primary": "google/gemini-3-pro",
                    "fallbacks": [],
                    "timeoutMs": 45000
                },
                "imageGenerationModel": {
                    "primary": "matchaclaw-media/custom-media-openai/gpt-image-2",
                    "fallbacks": [],
                    "timeoutMs": 120000
                },
                "mediaGenerationAutoProviderFallback": false
            }
        }))
    );
    assert_eq!(
        document.get("messages"),
        Some(&json!({
            "locale": "en",
            "tts": { "provider": "elevenlabs" }
        }))
    );
}

#[test]
fn removes_absent_routes_media_fallback_and_tts_provider_without_erasing_siblings() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "agents": {
                "defaults": {
                    "model": { "primary": "openai/old", "fallbacks": [] },
                    "imageModel": { "primary": "google/old", "fallbacks": [] },
                    "imageGenerationModel": { "primary": "media/old", "fallbacks": [] },
                    "videoGenerationModel": { "primary": "media/old", "fallbacks": [] },
                    "musicGenerationModel": { "primary": "media/old", "fallbacks": [] },
                    "mediaGenerationAutoProviderFallback": false,
                    "temperature": 0.3
                },
                "other": true
            },
            "messages": { "tts": { "provider": "old", "voice": "nova" }, "locale": "zh" }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");

    CapabilityRouting::default()
        .apply(&root.store())
        .expect("remove routes");
    let document = root.store().read().expect("read config");

    assert_eq!(
        document.get("agents"),
        Some(&json!({
            "defaults": { "temperature": 0.3 },
            "other": true
        }))
    );
    assert_eq!(
        document.get("messages"),
        Some(&json!({
            "tts": { "voice": "nova" },
            "locale": "zh"
        }))
    );
}

#[test]
fn reapplying_the_same_routing_is_a_no_op() {
    let root = TestRoot::new();
    let routing = CapabilityRouting {
        video_generate: Some(route("runway", "gen-4", &[], Some(60_000))),
        ..CapabilityRouting::default()
    };

    assert!(routing.apply(&root.store()).expect("initial apply").changed);
    assert!(!routing.apply(&root.store()).expect("repeat apply").changed);
}

#[test]
fn rejects_unsupported_chat_timeout_without_writing_config() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({ "gateway": { "port": 18789 } })).expect("serialize seed"),
    )
    .expect("seed config");
    let routing = CapabilityRouting {
        chat: Some(route("openai", "gpt-5.6", &[], Some(30_000))),
        ..CapabilityRouting::default()
    };

    let error = routing
        .apply(&root.store())
        .expect_err("reject chat timeout");
    assert_eq!(error, RoutingProjectionError::UnsupportedTimeout);
    assert_eq!(
        root.store().read().expect("read config").as_value(),
        json!({ "gateway": { "port": 18789 } })
    );
}

#[test]
fn identifiers_reject_ambiguous_or_sensitive_values_without_exposure() {
    let provider_error = ProviderKey::try_new("provider/key".into()).expect_err("reject slash");
    let model_error =
        ModelId::try_new(format!("bad\n{SECRET_CANARY}")).expect_err("reject control");
    let timeout_error = PositiveTimeoutMs::try_new(0).expect_err("reject zero");

    assert_eq!(provider_error, RoutingProjectionError::InvalidProviderKey);
    assert_eq!(model_error, RoutingProjectionError::InvalidModelId);
    assert_eq!(timeout_error, RoutingProjectionError::InvalidTimeoutMs);
    assert!(!format!("{provider_error:?} {provider_error}").contains("provider/key"));
    assert!(!format!("{model_error:?} {model_error}").contains(SECRET_CANARY));
}
