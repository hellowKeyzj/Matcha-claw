use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, params};

use super::*;
use crate::lifecycle::state_dir::CanonicalStateDir;

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
            "openclaw-auth-projection-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        let state_dir = CanonicalStateDir::provision(path.join("state")).expect("provision state");
        Self { path, state_dir }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_state_db_auth_fixture(root: &TestRoot, store: &str) {
    write_state_db_auth_fixture_with_state(root, store, r#"{"version":1}"#);
}

fn write_state_db_auth_fixture_with_state(root: &TestRoot, store: &str, state: &str) {
    let database_path = root
        .state_dir
        .as_path()
        .join("state")
        .join("openclaw.sqlite");
    fs::create_dir_all(database_path.parent().expect("state db parent"))
        .expect("create state db directory");
    let connection = Connection::open(database_path).expect("open state db");
    connection
        .execute(
            "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
            [],
        )
        .expect("create config_machine_state");
    for (state_key, value_json) in [
        (AUTH_SHARED_STORE_STATE_KEY, r#"{"location":"state-db"}"#),
        (AUTH_PROFILES_STATE_KEY, store),
        (AUTH_PROFILES_STATE_STATE_KEY, state),
    ] {
        connection
            .execute(
                "INSERT INTO config_machine_state (state_key, value_json) VALUES (?1, ?2)",
                params![state_key, value_json],
            )
            .expect("insert config_machine_state row");
    }
}

#[test]
fn profiles_publish_identity_and_credential_kind_without_secret_material() {
    let profile = AuthProfile::new(
        ProfileId::try_new("anthropic:primary".into()).unwrap(),
        ProviderId::try_new("anthropic".into()).unwrap(),
        CredentialKind::OAuth,
    );

    assert_eq!(profile.id().as_str(), "anthropic:primary");
    assert_eq!(profile.provider().as_str(), "anthropic");
    assert_eq!(profile.kind(), CredentialKind::OAuth);
    assert!(!format!("{profile:?}").contains("auth-secret-canary"));
}

#[test]
fn credential_reference_grammar_rejects_unknown_or_non_current_versions_without_echoing_them() {
    for value in [
        "credential:anthropic:primary",
        "credential:v2:anthropic:primary",
        "credential:v1:anthropic:primary/secret-canary",
    ] {
        let error = environment::CredentialReference::try_new(value).unwrap_err();

        assert_eq!(error.to_string(), "credential reference is invalid");
        assert!(!format!("{error:?} {error}").contains("secret-canary"));
    }
}

#[test]
fn state_db_auth_profiles_keep_only_non_secret_availability_state() {
    let store = serde_json::json!({
        "version": 1,
        "profiles": {
            "openai:default": {
                "type": "token",
                "provider": "openai",
                "token": "access-secret-canary",
                "expires": 2000
            }
        }
    });

    let profiles = parse_state_db_auth_profiles(&store, None).unwrap();
    let rendered = format!("{profiles:?}");

    assert_eq!(profiles[0].id.as_str(), "openai:default");
    assert_eq!(profiles[0].provider.as_str(), "openai");
    assert_eq!(profiles[0].kind, CredentialKind::Token);
    assert_eq!(profiles[0].expires, Some(2000));
    assert!(!rendered.contains("access-secret-canary"));
}

#[test]
fn credential_availability_requires_token_to_be_unexpired_at_the_supplied_time() {
    let root = TestRoot::new();
    write_state_db_auth_fixture(
        &root,
        r#"{"version":1,"profiles":{"openai:default":{"type":"token","provider":"openai","token":"access-token","expires":2000}}}"#,
    );
    let reference = environment::CredentialReference::try_new("credential:v1:account-id").unwrap();

    assert!(credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap());
    assert!(!credential_is_available(&root.state_dir, "openai", &reference, 2_000).unwrap());
    assert!(!credential_is_available(&root.state_dir, "openai", &reference, 2_001).unwrap());
}

#[test]
fn credential_availability_uses_provider_profile_not_credential_reference_id() {
    let root = TestRoot::new();
    write_state_db_auth_fixture(
        &root,
        r#"{"version":1,"profiles":{"openai:default":{"type":"api_key","provider":"openai","key":"api-key"}}}"#,
    );
    let reference = environment::CredentialReference::try_new("credential:v1:account-id").unwrap();

    assert!(credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap());
    assert!(!credential_is_available(&root.state_dir, "anthropic", &reference, 1_999).unwrap());
}

#[test]
fn credential_availability_accepts_native_secret_refs_without_resolving_them() {
    let root = TestRoot::new();
    write_state_db_auth_fixture(
        &root,
        r#"{"version":1,"profiles":{"custom-main:default":{"type":"api_key","provider":"custom-main","keyRef":{"source":"env","provider":"custom-main","id":"CUSTOM_MAIN_API_KEY"}}}}"#,
    );
    let reference = environment::CredentialReference::try_new("credential:v1:custom-main").unwrap();

    assert!(credential_is_available(&root.state_dir, "custom-main", &reference, 1_999).unwrap());
}

#[test]
fn credential_availability_accepts_oauth_access_or_refresh_token() {
    let root = TestRoot::new();
    write_state_db_auth_fixture(
        &root,
        r#"{"version":1,"profiles":{"openai:access":{"type":"oauth","provider":"openai","access":"access-token"},"anthropic:refresh":{"type":"oauth","provider":"anthropic","refresh":"refresh-token"}}}"#,
    );
    let reference = environment::CredentialReference::try_new("credential:v1:account-id").unwrap();

    assert!(credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap());
    assert!(credential_is_available(&root.state_dir, "anthropic", &reference, 1_999).unwrap());
}

#[test]
fn malformed_token_profile_fails_closed_without_exposing_profile_contents() {
    let root = TestRoot::new();
    write_state_db_auth_fixture(
        &root,
        r#"{"version":1,"profiles":{"openai:default":{"type":"token","provider":"openai","token":"access-secret-canary","expires":"invalid"}}}"#,
    );
    let reference = environment::CredentialReference::try_new("credential:v1:account-id").unwrap();

    let error = credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap_err();

    assert_eq!(error, AuthProjectionError::InvalidPersistedAuthProfiles);
    assert!(!format!("{error:?} {error}").contains("access-secret-canary"));
}
