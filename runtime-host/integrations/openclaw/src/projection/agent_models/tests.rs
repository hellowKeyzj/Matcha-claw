use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::json;

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::config_store::{OpenClawConfigMutation, OpenClawConfigStore},
};

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
            "openclaw-agent-model-projection-{}-{nanos}-{sequence}",
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

fn model(id: &str, context_window: Option<u64>, max_tokens: Option<u64>) -> Model {
    Model::try_new(
        ModelId::try_new(id.into()).unwrap(),
        context_window,
        max_tokens,
        vec![InputModality::Text],
    )
    .unwrap()
}

#[test]
fn provider_catalog_exposes_only_native_model_metadata() {
    let catalog = ProviderModels::try_new(
        ProviderId::try_new("anthropic".into()).unwrap(),
        vec![
            Model::try_new(
                ModelId::try_new("claude-sonnet-4-6".into()).unwrap(),
                Some(200_000),
                Some(64_000),
                vec![InputModality::Text, InputModality::Image],
            )
            .unwrap(),
        ],
    )
    .unwrap();

    assert_eq!(catalog.provider().as_str(), "anthropic");
    assert_eq!(catalog.models()[0].id().as_str(), "claude-sonnet-4-6");
    assert_eq!(catalog.models()[0].context_window(), Some(200_000));
    assert_eq!(catalog.models()[0].max_tokens(), Some(64_000));
    assert_eq!(
        catalog.models()[0].input(),
        [InputModality::Text, InputModality::Image]
    );
}

#[test]
fn model_rejects_zero_or_inverted_token_limits() {
    let id = ModelId::try_new("model".into()).unwrap();

    for limits in [(Some(0), None), (None, Some(0)), (Some(4_096), Some(4_097))] {
        let error = Model::try_new(id.clone(), limits.0, limits.1, vec![]).unwrap_err();

        assert_eq!(error, ModelProjectionError::InvalidTokenLimit);
        assert_eq!(error.to_string(), "OpenClaw model token limits are invalid");
    }
}

#[test]
fn provider_catalog_orders_models_by_identifier_before_projection() {
    let catalog = ProviderModels::try_new(
        ProviderId::try_new("openai".into()).unwrap(),
        vec![
            model("gpt-5.6", Some(128_000), Some(16_384)),
            model("gpt-4.1", Some(128_000), Some(16_384)),
        ],
    )
    .unwrap();

    assert_eq!(
        catalog
            .models()
            .iter()
            .map(|model| model.id().as_str())
            .collect::<Vec<_>>(),
        ["gpt-4.1", "gpt-5.6"]
    );
}

#[test]
fn provider_catalog_rejects_empty_and_duplicate_model_identifiers() {
    let provider = ProviderId::try_new("openai".into()).unwrap();

    assert_eq!(
        ProviderModels::try_new(provider.clone(), vec![]).unwrap_err(),
        ModelProjectionError::EmptyModelCatalog
    );
    assert_eq!(
        ProviderModels::try_new(
            provider,
            vec![
                model("gpt", Some(8_192), Some(4_096)),
                model("gpt", None, None),
            ],
        )
        .unwrap_err(),
        ModelProjectionError::DuplicateModelId
    );
}

#[test]
fn applies_models_without_overwriting_provider_transport_or_siblings() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "gateway": { "port": 18789 },
            "models": {
                "providers": {
                    "anthropic": {
                        "baseUrl": "https://api.anthropic.com",
                        "api": "anthropic-messages",
                        "agentRuntime": { "id": "pi" },
                        "models": [{ "id": "old", "name": "old" }]
                    },
                    "openai": { "baseUrl": "https://api.openai.com", "models": [] }
                },
                "pricing": { "enabled": true }
            }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");
    let models = ProviderModels::try_new(
        ProviderId::try_new("anthropic".into()).unwrap(),
        vec![
            Model::try_new(
                ModelId::try_new("claude-sonnet-4-6".into()).unwrap(),
                Some(200_000),
                Some(64_000),
                vec![InputModality::Text, InputModality::Image],
            )
            .unwrap(),
        ],
    )
    .unwrap();

    let update = root
        .store()
        .update(|document| {
            if models.apply_to_document(document) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .expect("apply models");
    let document = root.store().read().expect("read config");

    assert!(update.changed);
    assert_eq!(document.get("gateway"), Some(&json!({ "port": 18789 })));
    assert_eq!(
        document.get("models"),
        Some(&json!({
            "providers": {
                "anthropic": {
                    "baseUrl": "https://api.anthropic.com",
                    "api": "anthropic-messages",
                    "agentRuntime": { "id": "pi" },
                    "models": [{
                        "id": "claude-sonnet-4-6",
                        "name": "claude-sonnet-4-6",
                        "input": ["text", "image"],
                        "contextWindow": 200_000,
                        "maxTokens": 64_000
                    }]
                },
                "openai": { "baseUrl": "https://api.openai.com", "models": [] }
            },
            "pricing": { "enabled": true }
        }))
    );
}

#[test]
fn reapplying_the_same_model_catalog_is_a_no_op() {
    let root = TestRoot::new();
    let models = ProviderModels::try_new(
        ProviderId::try_new("openai".into()).unwrap(),
        vec![model("gpt-5.6", Some(128_000), Some(16_384))],
    )
    .unwrap();

    let apply = || {
        root.store()
            .update(|document| {
                if models.apply_to_document(document) {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .expect("apply models")
    };
    assert!(apply().changed);
    assert!(!apply().changed);
}

#[test]
fn identifiers_reject_empty_whitespace_and_control_characters_without_exposure() {
    for value in ["", " ", "invalid value", "bad\nmodel", "\u{0000}"] {
        let provider_error = ProviderId::try_new(value.into()).unwrap_err();
        let model_error = ModelId::try_new(value.into()).unwrap_err();

        assert_eq!(provider_error, ModelProjectionError::InvalidProviderId);
        assert_eq!(model_error, ModelProjectionError::InvalidModelId);
        if value.chars().any(|character| !character.is_whitespace()) {
            assert!(!provider_error.to_string().contains(value));
            assert!(!model_error.to_string().contains(value));
        }
    }
}
