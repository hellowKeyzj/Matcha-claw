use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::*;
use crate::migrate_provider_legacy_stores;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("matcha-provider-account-store-{name}-{id}.json"))
}

fn remove(path: &PathBuf) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(lock_path(path));
    let _ = fs::remove_file(temporary_path(path));
}

fn account(id: &str, provider: &str, revision: u64, label: &str) -> ProviderAccount {
    ProviderAccount::new(
        ProviderAccountId::try_new(id).unwrap(),
        ProviderReference::try_new(provider).unwrap(),
        ProviderAccountRevision::try_new(revision).unwrap(),
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: label.to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(ProviderEndpoint::try_new("https://api.example.com/v1").unwrap()),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::ApiKey,
            credential: Some(
                CredentialReference::try_new("credential:v1:private-profile").unwrap(),
            ),
            created_at: "2026-07-27T10:00:00Z".to_owned(),
            updated_at: "2026-07-27T10:00:00Z".to_owned(),
        })
        .unwrap(),
    )
}

#[test]
fn durable_store_recovers_sorted_non_secret_accounts() {
    let path = path("reopen");
    let mut store = ProviderAccountStore::open(&path).unwrap();
    store
        .persist(account("secondary", "provider:openai", 1, "Secondary"))
        .unwrap();
    store
        .persist(account("primary", "provider:openai", 1, "Primary"))
        .unwrap();
    drop(store);

    let reopened = ProviderAccountStore::open(&path).unwrap();
    assert_eq!(reopened.accounts().len(), 2);
    assert_eq!(reopened.accounts()[0].id().as_str(), "primary");
    assert_eq!(reopened.accounts()[1].id().as_str(), "secondary");
    assert_eq!(
        reopened.accounts()[0].configuration().created_at(),
        "2026-07-27T10:00:00Z"
    );
    assert_eq!(
        reopened.accounts()[0].configuration().updated_at(),
        "2026-07-27T10:00:00Z"
    );
    assert_eq!(
        reopened
            .account(&ProviderAccountId::try_new("primary").unwrap())
            .unwrap()
            .configuration()
            .credential()
            .unwrap()
            .as_str(),
        "credential:v1:private-profile"
    );
    let contents = fs::read_to_string(&path).unwrap();
    assert!(!contents.contains("secret-value-must-not-persist"));
    remove(&path);
}

#[test]
fn durable_store_requires_linear_revisions_and_immutable_provider() {
    let path = path("revision");
    let mut store = ProviderAccountStore::open(&path).unwrap();

    assert_eq!(
        store.persist(account("primary", "provider:openai", 2, "Primary")),
        Err(ProviderAccountStoreFault::InitialRevisionRequired)
    );
    store
        .persist(account("primary", "provider:openai", 1, "Primary"))
        .unwrap();
    assert_eq!(
        store.persist(account("primary", "provider:openai", 1, "Different")),
        Err(ProviderAccountStoreFault::RevisionConflict)
    );
    assert_eq!(
        store.persist(account("primary", "provider:openai", 3, "Primary")),
        Err(ProviderAccountStoreFault::RevisionMustFollowCurrent)
    );
    assert_eq!(
        store.persist(account("primary", "provider:anthropic", 2, "Primary")),
        Err(ProviderAccountStoreFault::ProviderImmutable)
    );
    store
        .persist(account("primary", "provider:openai", 2, "Updated"))
        .unwrap();
    assert_eq!(
        store
            .account(&ProviderAccountId::try_new("primary").unwrap())
            .unwrap()
            .configuration()
            .label(),
        "Updated"
    );
    remove(&path);
}

#[test]
fn durable_store_deletes_only_the_current_account_revision() {
    let path = path("delete");
    let mut store = ProviderAccountStore::open(&path).unwrap();
    let id = ProviderAccountId::try_new("primary").unwrap();
    store
        .persist(account("primary", "provider:openai", 1, "Primary"))
        .unwrap();

    assert_eq!(
        store.delete(&id, ProviderAccountRevision::try_new(2).unwrap()),
        Err(ProviderAccountStoreFault::RevisionMustFollowCurrent)
    );
    assert_eq!(
        store.delete(&id, ProviderAccountRevision::try_new(1).unwrap()),
        Ok(())
    );
    assert!(store.account(&id).is_none());
    assert_eq!(
        store.delete(&id, ProviderAccountRevision::try_new(1).unwrap()),
        Err(ProviderAccountStoreFault::UnknownAccount)
    );
    remove(&path);
}

#[test]
fn durable_store_replays_identical_revision_without_rewriting_facts() {
    let path = path("replay");
    let mut store = ProviderAccountStore::open(&path).unwrap();
    let primary = account("primary", "provider:openai", 1, "Primary");

    store.persist(primary.clone()).unwrap();
    let before = fs::read(&path).unwrap();
    let replayed = store.persist(primary).unwrap();

    assert_eq!(replayed.revision().get(), 1);
    assert_eq!(fs::read(&path).unwrap(), before);
    remove(&path);
}

#[test]
fn durable_store_rejects_unknown_fields_and_duplicate_ids() {
    let invalid_path = path("invalid");
    fs::write(
        &invalid_path,
        r#"{"version":1,"accounts":[{"id":"primary","provider":"provider:openai","revision":1,"label":"Primary","enabled":true,"endpoint":null,"protocol":null,"auth_mode":"local","credential":null}],"extra":true}"#,
    )
    .unwrap();
    assert!(matches!(
        ProviderAccountStore::open(&invalid_path),
        Err(ProviderAccountStoreFault::Decode)
    ));
    remove(&invalid_path);

    let path = path("duplicate");
    let record = r#"{"id":"primary","provider":"provider:openai","revision":1,"label":"Primary","enabled":true,"endpoint":null,"protocol":null,"auth_mode":"local","credential":null}"#;
    fs::write(
        &path,
        format!(r#"{{"version":1,"accounts":[{record},{record}]}}"#),
    )
    .unwrap();
    assert!(matches!(
        ProviderAccountStore::open(&path),
        Err(ProviderAccountStoreFault::Decode)
    ));
    remove(&path);
}

#[test]
fn reopening_discards_an_uncommitted_replacement_file() {
    let path = path("stale-replacement");
    fs::write(temporary_path(&path), b"uncommitted").unwrap();

    let store = ProviderAccountStore::open(&path).unwrap();

    assert!(store.accounts().is_empty());
    assert!(!temporary_path(&path).exists());
    remove(&path);
}

#[test]
fn legacy_v2_public_accounts_migrate_once_without_secrets() {
    let path = path("legacy-migrate");
    fs::write(
        &path,
        r#"{
          "schemaVersion": 2,
          "accounts": {
            "openai-main": {
              "id": "stale-id",
              "vendorId": " openai ",
              "label": "OpenAI Main",
              "authMode": "api_key",
              "enabled": true,
              "providerKind": "chat",
              "baseUrl": "https://api.openai.com/v1",
              "apiProtocol": "openai-responses",
              "createdAt": "2026-07-27T10:00:00Z",
              "updatedAt": "2026-07-27T11:00:00Z",
              "model": "legacy-model",
              "defaultAccountId": "openai-main"
            }
          },
          "apiKeys": { "openai-main": "secret-canary" }
        }"#,
    )
    .unwrap();

    assert!(matches!(
        ProviderAccountStore::open(&path),
        Err(ProviderAccountStoreFault::Decode)
    ));
    migrate_provider_legacy_stores(
        &path,
        path.with_file_name("missing-provider-models.json"),
        path.with_file_name("missing-provider-routing.json"),
    )
    .unwrap();
    let store = ProviderAccountStore::open(&path).unwrap();
    let account = &store.accounts()[0];
    assert_eq!(account.id().as_str(), "openai-main");
    assert_eq!(account.provider().as_str(), "provider:openai");
    assert_eq!(account.revision().get(), 1);
    assert_eq!(
        account.configuration().protocol(),
        Some(ProviderApiProtocol::OpenAiResponses)
    );
    assert_eq!(
        account.configuration().credential().unwrap().as_str(),
        "credential:v1:openai-main"
    );
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("\"version\":1"));
    assert!(!contents.contains("schemaVersion"));
    assert!(!contents.contains("apiKeys"));
    assert!(!contents.contains("secret-canary"));
    assert!(!format!("{account:?}").contains("secret-canary"));
    drop(store);

    let reopened = ProviderAccountStore::open(&path).unwrap();
    assert_eq!(reopened.accounts().len(), 1);
    assert_eq!(reopened.accounts()[0].id().as_str(), "openai-main");
    remove(&path);
}

#[test]
fn legacy_invalid_public_account_fails_closed() {
    let path = path("legacy-invalid");
    fs::write(
        &path,
        r#"{"schemaVersion":2,"accounts":{"broken":{"id":"broken","vendorId":"openai","label":"Broken","authMode":"not-a-mode","enabled":true,"createdAt":"now","updatedAt":"now"}},"apiKeys":{"broken":"secret-canary"}}"#,
    )
    .unwrap();
    assert!(matches!(
        ProviderAccountStore::open(&path),
        Err(ProviderAccountStoreFault::Decode)
    ));
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("secret-canary"));
    remove(&path);
}

#[test]
fn separately_opened_writers_refresh_before_committing() {
    let path = path("writers");
    let mut first = ProviderAccountStore::open(&path).unwrap();
    let mut second = ProviderAccountStore::open(&path).unwrap();

    first
        .persist(account("primary", "provider:openai", 1, "Primary"))
        .unwrap();
    second
        .persist(account("primary", "provider:openai", 2, "Updated"))
        .unwrap();

    assert_eq!(
        ProviderAccountStore::open(&path)
            .unwrap()
            .account(&ProviderAccountId::try_new("primary").unwrap())
            .unwrap()
            .revision()
            .get(),
        2
    );
    remove(&path);
}
