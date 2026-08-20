use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use environment::ProviderModelCapability;
use serde_json::json;

use crate::{
    lifecycle::state_dir::CanonicalStateDir, projection::config_store::OpenClawConfigStore,
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
            "openclaw-media-model-projection-{}-{nanos}-{sequence}",
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

fn catalog() -> ProviderModels {
    ProviderModels::try_new(
        ProviderKey::try_new("custom-media-openai".into()).unwrap(),
        "OpenAI media".into(),
        Endpoint::try_new("https://api.openai.com/v1".into()).unwrap(),
        Protocol::OpenAi,
        vec![
            Model::try_new(
                ModelId::try_new("gpt-image-2".into()).unwrap(),
                vec![ProviderModelCapability::ImageGenerate],
                Some(180_000),
                Some("16:9".into()),
                Some("2K".into()),
                Some("high".into()),
            )
            .unwrap(),
            Model::try_new(
                ModelId::try_new("gpt-4o-mini-tts".into()).unwrap(),
                vec![ProviderModelCapability::TextToSpeech],
                None,
                None,
                None,
                None,
            )
            .unwrap(),
        ],
    )
    .unwrap()
}

#[test]
fn writes_custom_media_plugin_configuration_without_exposing_material() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "gateway": { "port": 18789 },
            "plugins": { "allow": ["other"], "entries": { "other": { "enabled": true } } },
            "models": { "providers": { "custom-media-openai": { "baseUrl": "https://obsolete" } } }
        }))
        .unwrap(),
    )
    .unwrap();

    let update = MediaProviderCatalog::try_new(vec![catalog()])
        .unwrap()
        .apply(&root.store())
        .expect("apply media catalog");
    let document = root.store().read().expect("read config");

    assert!(update.changed);
    assert_eq!(document.get("gateway"), Some(&json!({ "port": 18789 })));
    assert_eq!(
        document.get("plugins"),
        Some(&json!({
            "allow": ["matchaclaw-media", "other"],
            "entries": {
                "other": { "enabled": true },
                "matchaclaw-media": {
                    "enabled": true,
                    "config": {
                        "providers": {
                            "custom-media-openai": {
                                "label": "OpenAI media",
                                "baseUrl": "https://api.openai.com/v1",
                                "apiProtocol": "openai",
                                "models": [
                                    {
                                        "id": "gpt-4o-mini-tts",
                                        "capabilities": ["tts"]
                                    },
                                    {
                                        "id": "gpt-image-2",
                                        "capabilities": ["imageGenerate"],
                                        "timeoutMs": 180000,
                                        "aspectRatio": "16:9",
                                        "resolution": "2K",
                                        "quality": "high"
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }))
    );
}

#[test]
fn rejects_non_media_capabilities_and_sensitive_endpoint_forms() {
    let model = Model::try_new(
        ModelId::try_new("gpt".into()).unwrap(),
        vec![ProviderModelCapability::Chat],
        None,
        None,
        None,
        None,
    );
    assert_eq!(model.unwrap_err(), MediaCatalogError::InvalidCapabilities);

    let endpoint = Endpoint::try_new("https://secret@example.com/v1".into());
    assert_eq!(endpoint.unwrap_err(), MediaCatalogError::InvalidEndpoint);
}

#[test]
fn repeat_application_is_a_no_op() {
    let root = TestRoot::new();
    let catalog = MediaProviderCatalog::try_new(vec![catalog()]).unwrap();
    assert!(catalog.apply(&root.store()).unwrap().changed);
    assert!(!catalog.apply(&root.store()).unwrap().changed);
}

#[test]
fn catalog_replaces_the_managed_provider_set_as_one_projection() {
    let root = TestRoot::new();
    let other = ProviderModels::try_new(
        ProviderKey::try_new("custom-media-google".into()).unwrap(),
        "Google media".into(),
        Endpoint::try_new("https://generativelanguage.googleapis.com/v1beta".into()).unwrap(),
        Protocol::Google,
        vec![
            Model::try_new(
                ModelId::try_new("gemini-image".into()).unwrap(),
                vec![ProviderModelCapability::ImageGenerate],
                None,
                None,
                None,
                None,
            )
            .unwrap(),
        ],
    )
    .unwrap();
    let catalog = MediaProviderCatalog::try_new(vec![other, catalog()]).unwrap();

    assert!(catalog.apply(&root.store()).unwrap().changed);
    assert!(!catalog.apply(&root.store()).unwrap().changed);
    let document = root.store().read().unwrap();
    let providers =
        &document.get("plugins").unwrap()["entries"]["matchaclaw-media"]["config"]["providers"];
    assert_eq!(providers.as_object().unwrap().len(), 2);
}
