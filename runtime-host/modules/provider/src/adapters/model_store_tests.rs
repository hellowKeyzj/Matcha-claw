use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::Value;

use super::*;
use crate::migrate_provider_legacy_stores;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("matcha-provider-model-store-{name}-{id}.json"))
}

fn remove(path: &PathBuf) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(lock_path(path));
    let _ = fs::remove_file(temporary_path(path));
}

fn missing_path(path: &PathBuf, name: &str) -> PathBuf {
    path.with_file_name(format!(
        "{}-{name}.json",
        path.file_stem().unwrap().to_string_lossy()
    ))
}

fn account_id(value: &str) -> ProviderAccountId {
    ProviderAccountId::try_new(value).unwrap()
}

fn model(account_id: ProviderAccountId, model_id: &str) -> ProviderModel {
    ProviderModel::try_new(
        account_id,
        model_id,
        vec![
            ProviderModelCapability::Chat,
            ProviderModelCapability::ImageUnderstand,
        ],
        Some(200_000),
        Some(8_000),
        Some(30_000),
        None,
        None,
        None,
    )
    .unwrap()
}

#[test]
fn durable_store_recovers_canonical_desired_models_without_projection_or_observation() {
    let path = path("reopen");
    let account_id = account_id("primary");
    let mut store = ProviderModelStore::open(&path).unwrap();

    store
        .replace(
            &account_id,
            vec![
                model(account_id.clone(), "z-model"),
                model(account_id.clone(), "a-model"),
            ],
        )
        .unwrap();
    drop(store);

    let reopened = ProviderModelStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .catalog()
            .models()
            .iter()
            .map(ProviderModel::model_id)
            .collect::<Vec<_>>(),
        ["a-model", "z-model"]
    );
    assert_eq!(
        reopened
            .catalog()
            .selectable_for(ProviderModelCapability::ImageUnderstand)
            .len(),
        2
    );
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("\"account_id\":\"primary\""));
    for forbidden in [
        "credential",
        "baseUrl",
        "headers",
        "apiKey",
        "secret-value-must-not-persist",
        "observed",
        "applied",
    ] {
        assert!(!contents.contains(forbidden));
    }
    remove(&path);
}

#[test]
fn migrates_legacy_camel_case_catalog_once_and_reopens_as_canonical() {
    let path = path("legacy-migration");
    fs::write(
        &path,
        r#"{
          "schemaVersion": 1,
          "models": [
            {
              "credentialId": " primary ",
              "modelId": " model-a ",
              "capabilities": ["chat", "chat", "imageUnderstand", "unknown"],
              "contextWindow": 200000.9,
              "maxTokens": 0,
              "timeoutMs": 30000.8,
              "aspectRatio": " 16:9 ",
              "resolution": "1080p",
              "quality": "high",
              "baseUrl": "https://secret.example",
              "apiKey": "secret-value-must-not-persist"
            },
            {
              "credentialId": "primary",
              "modelId": "model-a",
              "capabilities": ["imageGenerate"]
            },
            {
              "credentialId": "primary",
              "modelId": "model-b",
              "capabilities": ["tts", "tts"]
            }
          ]
        }"#,
    )
    .unwrap();

    assert!(matches!(
        ProviderModelStore::open(&path),
        Err(ProviderModelStoreFault::Decode)
    ));
    migrate_provider_legacy_stores(
        missing_path(&path, "provider-accounts"),
        &path,
        missing_path(&path, "provider-routing"),
        (
            Vec::<PathBuf>::new(),
            Vec::<PathBuf>::new(),
            Vec::<PathBuf>::new(),
        ),
    )
    .unwrap();
    let store = ProviderModelStore::open(&path).unwrap();
    assert_eq!(store.catalog().models().len(), 2);
    let first = &store.catalog().models()[0];
    assert_eq!(first.account_id().as_str(), "primary");
    assert_eq!(first.model_id(), "model-a");
    assert_eq!(
        first.capabilities(),
        &[
            ProviderModelCapability::Chat,
            ProviderModelCapability::ImageUnderstand
        ]
    );
    assert_eq!(first.context_window(), Some(200000));
    assert_eq!(first.max_tokens(), None);
    assert_eq!(first.timeout_ms(), Some(30000));
    assert_eq!(first.aspect_ratio(), Some("16:9"));
    assert_eq!(first.resolution(), Some("1080p"));
    assert_eq!(first.quality(), Some("high"));

    let contents = fs::read_to_string(&path).unwrap();
    let canonical: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(canonical["version"], 1);
    assert!(canonical["models"][0].get("account_id").is_some());
    assert!(canonical["models"][0].get("model_id").is_some());
    for forbidden in [
        "schemaVersion",
        "credentialId",
        "baseUrl",
        "apiKey",
        "secret-value-must-not-persist",
    ] {
        assert!(!contents.contains(forbidden));
    }
    drop(store);

    let reopened = ProviderModelStore::open(&path).unwrap();
    assert_eq!(reopened.catalog().models().len(), 2);
    remove(&path);
}

#[test]
fn replacement_clears_only_the_selected_account_identity() {
    let path = path("replace");
    let first = account_id("first");
    let second = account_id("second");
    let mut store = ProviderModelStore::open(&path).unwrap();
    store
        .replace(&first, vec![model(first.clone(), "first-model")])
        .unwrap();
    store
        .replace(&second, vec![model(second.clone(), "second-model")])
        .unwrap();

    store.replace(&first, Vec::new()).unwrap();

    assert_eq!(
        store
            .catalog()
            .models()
            .iter()
            .map(ProviderModel::model_id)
            .collect::<Vec<_>>(),
        ["second-model"]
    );
    remove(&path);
}

#[test]
fn durable_store_fails_closed_for_legacy_credential_or_unknown_fields() {
    for (name, field) in [
        (
            "legacy-credential",
            "\"credential\":\"credential:v1:legacy\"",
        ),
        ("unknown", "\"baseUrl\":\"https://secret.example\""),
    ] {
        let path = path(name);
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"models\":[{{\"account_id\":\"primary\",\"model_id\":\"chat\",\"capabilities\":[\"chat\"],\"context_window\":null,\"max_tokens\":null,\"timeout_ms\":null,\"aspect_ratio\":null,\"resolution\":null,\"quality\":null,{field}}}]}}"
            ),
        )
        .unwrap();

        assert!(matches!(
            ProviderModelStore::open(&path),
            Err(ProviderModelStoreFault::Decode)
        ));
        remove(&path);
    }
}
