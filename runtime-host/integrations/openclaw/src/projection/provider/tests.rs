use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::json;

use crate::lifecycle::state_dir::CanonicalStateDir;

use super::*;

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
            "openclaw-provider-projection-{}-{nanos}-{sequence}",
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
    ProviderKey::try_new(value.into()).expect("valid provider key")
}

fn endpoint(value: &str) -> ProviderEndpoint {
    ProviderEndpoint::try_new(value.into()).expect("valid endpoint")
}

#[test]
fn replaces_legacy_provider_entries_without_erasing_the_current_provider_fields() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "models": {
                "providers": {
                    "openai": {
                        "baseUrl": "https://legacy.example.com/v1",
                        "api": "openai-completions",
                        "models": [{ "id": "gpt-5.6", "name": "GPT 5.6" }],
                        "customProviderField": true
                    },
                    "openai-codex": {
                        "models": [{ "id": "legacy", "name": "Legacy" }]
                    }
                }
            }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");
    let projection = ProviderProjection::new(
        provider("openai"),
        endpoint("https://api.openai.com/v1"),
        ProviderProtocol::OpenAiResponses,
        None,
        [provider("openai-codex")],
    );

    projection.apply(&root.store()).expect("apply projection");
    let document = root.store().read().expect("read config");

    assert_eq!(
        document.get("models"),
        Some(&json!({
            "providers": {
                "openai": {
                    "baseUrl": "https://api.openai.com/v1",
                    "api": "openai-responses",
                    "models": [{ "id": "gpt-5.6", "name": "GPT 5.6" }],
                    "customProviderField": true,
                    "agentRuntime": { "id": "pi" }
                }
            }
        }))
    );
}

#[test]
fn projects_moonshot_search_endpoint_without_an_inline_key() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "tools": {
                "web": {
                    "search": {
                        "kimi": { "region": "legacy" }
                    }
                }
            }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");
    let projection = ProviderProjection::new(
        provider("moonshot-global"),
        endpoint("https://api.moonshot.ai/v1"),
        ProviderProtocol::OpenAiCompletions,
        None,
        [],
    );

    projection.apply(&root.store()).expect("apply projection");
    let document = root.store().read().expect("read config");

    assert_eq!(
        document.get("tools"),
        Some(&json!({
            "web": {
                "search": {
                    "kimi": {
                        "baseUrl": "https://api.moonshot.ai/v1",
                        "region": "legacy"
                    }
                }
            }
        }))
    );
}

#[test]
fn rejects_secret_bearing_endpoint_without_exposure() {
    let secret_endpoint = format!("https://user:{SECRET_CANARY}@api.example.com/v1");
    let endpoint_error =
        ProviderEndpoint::try_new(secret_endpoint.clone()).expect_err("reject endpoint");

    assert_eq!(endpoint_error, ProviderProjectionError::InvalidEndpoint);
    assert!(!format!("{endpoint_error:?} {endpoint_error}").contains(SECRET_CANARY));
}

#[test]
fn debug_output_redacts_provider_projection_configuration() {
    let projection = ProviderProjection::new(
        provider("openrouter"),
        endpoint("https://openrouter.ai/api/v1"),
        ProviderProtocol::OpenAiResponses,
        None,
        [],
    );

    let rendered = format!("{projection:?}");

    assert_eq!(rendered, "ProviderProjection([REDACTED])");
    assert!(!rendered.contains("OPENROUTER_API_KEY"));
    assert!(!rendered.contains("matchaclaw.local"));
}
