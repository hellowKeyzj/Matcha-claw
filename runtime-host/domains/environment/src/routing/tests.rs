use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::*;
use crate::migrate_provider_legacy_stores;
use crate::routing::store::{lock_path, temporary_path};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "matcha-provider-routing-{name}-{}-{id}.json",
        std::process::id()
    ))
}

fn remove(path: &PathBuf) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(lock_path(path));
    let _ = fs::remove_file(temporary_path(path));
}

fn reference(account_id: &str, model_id: &str) -> ProviderModelReference {
    ProviderModelReference::try_new(ProviderAccountId::try_new(account_id).unwrap(), model_id)
        .unwrap()
}

fn routing(revision: u64, chat_model: &str) -> ProviderRouting {
    ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(revision).unwrap(),
        vec![
            (
                ProviderRoutingCapability::Chat,
                ProviderRoute::try_new(
                    reference("primary", chat_model),
                    vec![reference("backup", "chat-fallback")],
                    Some(30_000),
                )
                .unwrap(),
            ),
            (
                ProviderRoutingCapability::Tts,
                ProviderRoute::try_new(reference("voice", "tts-1"), Vec::new(), None).unwrap(),
            ),
        ],
    )
    .unwrap()
}

#[test]
fn routing_is_canonical_and_rejects_invalid_route_shapes() {
    let primary = reference("primary", "chat-main");
    assert_eq!(
        ProviderRoute::try_new(primary.clone(), vec![primary], None),
        Err(InvalidProviderRoute::DuplicateModel)
    );
    assert_eq!(
        ProviderRoute::try_new(reference("primary", "chat-main"), Vec::new(), Some(0)),
        Err(InvalidProviderRoute::Timeout)
    );
    assert_eq!(
        ProviderRouting::try_new(
            ProviderRoutingRevision::try_new(1).unwrap(),
            vec![
                (
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(reference("primary", "a"), Vec::new(), None).unwrap(),
                ),
                (
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(reference("backup", "b"), Vec::new(), None).unwrap(),
                ),
            ],
        ),
        Err(InvalidProviderRouting)
    );
    let routing = routing(1, "chat-main");
    assert_eq!(
        routing
            .routes()
            .iter()
            .map(|(capability, _)| *capability)
            .collect::<Vec<_>>(),
        [
            ProviderRoutingCapability::Chat,
            ProviderRoutingCapability::Tts
        ]
    );
}

#[test]
fn durable_store_recovers_strict_v1_non_secret_desired_routing() {
    let path = path("reopen");
    let mut store = ProviderRoutingStore::open(&path).unwrap();
    store.replace(routing(1, "chat-main")).unwrap();
    drop(store);

    let reopened = ProviderRoutingStore::open(&path).unwrap();
    let routing = reopened.routing().unwrap();
    assert_eq!(routing.revision().get(), 1);
    assert_eq!(
        routing
            .route(ProviderRoutingCapability::Chat)
            .unwrap()
            .primary()
            .model_id(),
        "chat-main"
    );
    assert_eq!(
        routing
            .route(ProviderRoutingCapability::Chat)
            .unwrap()
            .fallbacks()
            .iter()
            .map(ProviderModelReference::model_id)
            .collect::<Vec<_>>(),
        ["chat-fallback"]
    );
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("\"account_id\":\"primary\""));
    for forbidden in [
        "credential",
        "apiKey",
        "headers",
        "endpoint",
        "baseUrl",
        "secret-value",
    ] {
        assert!(!contents.contains(forbidden));
    }
    remove(&path);
}

#[test]
fn store_requires_linear_revisions_and_accepts_identical_replay() {
    let path = path("revision");
    let mut store = ProviderRoutingStore::open(&path).unwrap();
    assert_eq!(
        store.replace(routing(2, "chat-main")),
        Err(ProviderRoutingStoreFault::InitialRevisionRequired)
    );
    store.replace(routing(1, "chat-main")).unwrap();
    let before = fs::read(&path).unwrap();
    store.replace(routing(1, "chat-main")).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        store.replace(routing(1, "chat-other")),
        Err(ProviderRoutingStoreFault::RevisionConflict)
    );
    assert_eq!(
        store.replace(routing(3, "chat-other")),
        Err(ProviderRoutingStoreFault::RevisionMustFollowCurrent)
    );
    assert_eq!(
        store
            .replace(routing(2, "chat-other"))
            .unwrap()
            .revision()
            .get(),
        2
    );
    assert_eq!(
        store.replace(routing(1, "chat-main")),
        Err(ProviderRoutingStoreFault::StaleRevision)
    );
    remove(&path);
}

#[test]
fn legacy_routing_is_migrated_to_canonical_and_reopens() {
    let path = path("legacy-migration");
    fs::write(
        &path,
        r#"{
          "schemaVersion":1,
          "routing":{
            "chat":{"primary":{"credentialId":"chat-account","modelId":"chat-main"},"fallbacks":[],"timeoutMs":1200},
            "imageUnderstand":{"primary":{"credentialId":"image-account","modelId":"image-understand"},"fallbacks":[]},
            "imageGenerate":{"primary":{"credentialId":"image-account","modelId":"image-generate"},"fallbacks":[]},
            "videoGenerate":{"primary":{"credentialId":"video-account","modelId":"video-generate"},"fallbacks":[]},
            "musicGenerate":{"primary":{"credentialId":"music-account","modelId":"music-generate"},"fallbacks":[]},
            "tts":{"primary":{"credentialId":"tts-account","modelId":"tts"},"fallbacks":[]}
          },
          "ignored":true
        }"#,
    )
    .unwrap();

    assert!(matches!(
        ProviderRoutingStore::open(&path),
        Err(ProviderRoutingStoreFault::Decode)
    ));
    migrate_provider_legacy_stores(
        path.with_file_name("missing-provider-accounts.json"),
        path.with_file_name("missing-provider-models.json"),
        &path,
    )
    .unwrap();
    let store = ProviderRoutingStore::open(&path).unwrap();
    let routing = store.routing().unwrap().clone();
    assert_eq!(routing.routes().len(), 6);
    assert_eq!(routing.revision().get(), 1);
    assert_eq!(
        routing
            .route(ProviderRoutingCapability::Chat)
            .unwrap()
            .timeout_ms(),
        Some(1200)
    );

    let canonical = fs::read_to_string(&path).unwrap();
    assert!(canonical.contains(r#""version":1"#));
    assert!(canonical.contains(r#""account_id":"chat-account""#));
    assert!(!canonical.contains("schemaVersion"));

    drop(store);
    let reopened = ProviderRoutingStore::open(&path).unwrap();
    assert_eq!(reopened.routing(), Some(&routing));
    remove(&path);
}

#[test]
fn legacy_routing_requires_primary_and_prunes_invalid_fallbacks() {
    let path = path("legacy-pruning");
    fs::write(
        &path,
        r#"{
          "schemaVersion":1,
          "routing":{
            "chat":{"primary":{"credentialId":"primary","modelId":"chat"},"fallbacks":[{"credentialId":"backup","modelId":"one"},{"credentialId":"primary","modelId":"chat"},{"credentialId":"backup","modelId":"one"},{"credentialId":"","modelId":"bad"},"bad"],"timeoutMs":12.9},
            "imageGenerate":{"primary":{"credentialId":"","modelId":"missing"},"fallbacks":[{"credentialId":"backup","modelId":"ignored"}],"timeoutMs":0},
            "videoGenerate":{"fallbacks":[],"timeoutMs":-1},
            "unknown":{"primary":{"credentialId":"unknown","modelId":"unknown"}}
          }
        }"#,
    )
    .unwrap();

    migrate_provider_legacy_stores(
        path.with_file_name("missing-provider-accounts.json"),
        path.with_file_name("missing-provider-models.json"),
        &path,
    )
    .unwrap();
    let store = ProviderRoutingStore::open(&path).unwrap();
    let chat = store
        .routing()
        .unwrap()
        .route(ProviderRoutingCapability::Chat)
        .unwrap();
    assert_eq!(chat.fallbacks().len(), 1);
    assert_eq!(chat.fallbacks()[0].model_id(), "one");
    assert_eq!(chat.timeout_ms(), Some(12));
    assert!(
        store
            .routing()
            .unwrap()
            .route(ProviderRoutingCapability::ImageGenerate)
            .is_none()
    );
    assert!(
        store
            .routing()
            .unwrap()
            .route(ProviderRoutingCapability::VideoGenerate)
            .is_none()
    );
    remove(&path);
}

#[test]
fn legacy_routing_ignores_secret_bearing_unknown_fields() {
    let path = path("legacy-secret");
    const SECRET_CANARY: &str = "legacy-secret-canary";
    fs::write(
        &path,
        format!(
            r#"{{"schemaVersion":1,"routing":{{"chat":{{"primary":{{"credentialId":"primary","modelId":"chat"}},"fallbacks":[],"apiKey":"{SECRET_CANARY}"}}}},"secret":"{SECRET_CANARY}"}}"#
        ),
    )
    .unwrap();

    migrate_provider_legacy_stores(
        path.with_file_name("missing-provider-accounts.json"),
        path.with_file_name("missing-provider-models.json"),
        &path,
    )
    .unwrap();
    let store = ProviderRoutingStore::open(&path).unwrap();
    let canonical = fs::read_to_string(&path).unwrap();
    assert!(!canonical.contains(SECRET_CANARY));
    assert!(!format!("{:?}", store.routing()).contains(SECRET_CANARY));
    remove(&path);
}

#[test]
fn store_rejects_wrong_v1_schema_legacy_credential_or_unknown_fields() {
    let wrong_version = path("version");
    fs::write(&wrong_version, r#"{"version":2,"revision":1,"routes":[]}"#).unwrap();
    assert!(matches!(
        ProviderRoutingStore::open(&wrong_version),
        Err(ProviderRoutingStoreFault::Decode)
    ));
    remove(&wrong_version);

    for (name, field) in [
        (
            "legacy-credential",
            "\"credential\":\"credential:v1:legacy\"",
        ),
        ("unknown", "\"apiKey\":\"secret-value\""),
    ] {
        let path = path(name);
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"revision\":1,\"routes\":[{{\"capability\":\"chat\",\"primary\":{{\"account_id\":\"primary\",\"model_id\":\"chat-main\",{field}}},\"fallbacks\":[],\"timeout_ms\":null}}]}}"
            ),
        )
        .unwrap();
        assert!(matches!(
            ProviderRoutingStore::open(&path),
            Err(ProviderRoutingStoreFault::Decode)
        ));
        remove(&path);
    }
}

#[test]
fn store_rejects_a_routing_document_above_its_durable_size_limit() {
    let path = path("size");
    let fallbacks = (0..2_500)
        .map(|index| reference("backup", &format!("{index:04}-{}", "m".repeat(500))))
        .collect();
    let oversized = ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(1).unwrap(),
        vec![(
            ProviderRoutingCapability::Chat,
            ProviderRoute::try_new(reference("primary", "chat-main"), fallbacks, None).unwrap(),
        )],
    )
    .unwrap();
    let mut store = ProviderRoutingStore::open(&path).unwrap();

    assert_eq!(
        store.replace(oversized),
        Err(ProviderRoutingStoreFault::RecordTooLarge)
    );
    assert!(!path.exists());
    remove(&path);
}

#[test]
fn store_uses_an_exclusive_writer_lock() {
    let path = path("lock");
    let _lock = fs::File::create_new(lock_path(&path)).unwrap();
    assert!(matches!(
        ProviderRoutingStore::open(&path),
        Err(ProviderRoutingStoreFault::WriterBusy)
    ));
    drop(_lock);
    remove(&path);
}
