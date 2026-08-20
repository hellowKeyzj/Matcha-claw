use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;
use crate::lifecycle::state_dir::{AgentId, CanonicalStateDir, PrivateAuthProfiles};

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

trait AmbiguousIfClone<A> {}
impl<T> AmbiguousIfClone<()> for T {}
impl<T: Clone> AmbiguousIfClone<u8> for T {}

trait AmbiguousIfDisplay<A> {}
impl<T> AmbiguousIfDisplay<()> for T {}
impl<T: fmt::Display> AmbiguousIfDisplay<u8> for T {}

trait AmbiguousIfSerialize<A> {}
impl<T> AmbiguousIfSerialize<()> for T {}
impl<T: serde::Serialize> AmbiguousIfSerialize<u8> for T {}

fn assert_not_clone<T: AmbiguousIfClone<A>, A>() {}
fn assert_not_display<T: AmbiguousIfDisplay<A>, A>() {}
fn assert_not_serialize<T: AmbiguousIfSerialize<A>, A>() {}

#[test]
fn private_credentials_are_redacted_and_cannot_cross_public_projections() {
    assert_not_clone::<PrivateCredential, _>();
    assert_not_display::<PrivateCredential, _>();
    assert_not_serialize::<PrivateCredential, _>();

    let credential = PrivateCredential::try_new("auth-secret-canary".into()).unwrap();

    assert_eq!(
        format!("{credential:?}"),
        "PrivateCredential(\"[REDACTED]\")"
    );
    assert!(!format!("{credential:?}").contains("auth-secret-canary"));
}

#[test]
fn private_credentials_reject_empty_or_blank_values_without_exposure() {
    for value in ["", " \t\n ", "\r\n"] {
        let error = PrivateCredential::try_new(value.into()).unwrap_err();

        assert_eq!(error, AuthProjectionError::EmptyCredential);
        assert_eq!(error.to_string(), "OpenClaw credential is invalid");
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
fn private_auth_profiles_do_not_expose_credentials_through_debug_output() {
    let profile = PrivateAuthProfile::oauth(
        ProfileId::try_new("openai:primary".into()).unwrap(),
        ProviderId::try_new("openai".into()).unwrap(),
        PrivateCredential::try_new("access-secret-canary".into()).unwrap(),
        PrivateCredential::try_new("refresh-secret-canary".into()).unwrap(),
        1,
    );

    let rendered = format!("{profile:?}");

    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("secret-canary"));
}

#[test]
fn credential_availability_requires_oauth_to_be_unexpired_at_the_supplied_time() {
    let root = TestRoot::new();
    let agent = AgentId::try_new("main".into()).unwrap();
    let document = br#"{"version":1,"profiles":{"openai:oauth":{"type":"oauth","provider":"openai","access":"access-token","refresh":"refresh-token","expires":2000}}}"#;
    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(document.to_vec()).unwrap(),
        )
        .unwrap();
    let reference =
        environment::CredentialReference::try_new("credential:v1:openai:oauth").unwrap();

    assert!(credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap());
    assert!(!credential_is_available(&root.state_dir, "openai", &reference, 2_000).unwrap());
    assert!(!credential_is_available(&root.state_dir, "openai", &reference, 2_001).unwrap());
}

#[test]
fn credential_availability_uses_provider_profile_not_credential_reference_id() {
    let root = TestRoot::new();
    let agent = AgentId::try_new("main".into()).unwrap();
    let document = br#"{"version":1,"profiles":{"openai:default":{"type":"api_key","provider":"openai","key":"api-key"}}}"#;
    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(document.to_vec()).unwrap(),
        )
        .unwrap();
    let reference = environment::CredentialReference::try_new("credential:v1:account-id").unwrap();

    assert!(credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap());
    assert!(!credential_is_available(&root.state_dir, "anthropic", &reference, 1_999).unwrap());
}

#[test]
fn credential_availability_accepts_native_secret_refs_without_resolving_them() {
    let root = TestRoot::new();
    let agent = AgentId::try_new("main".into()).unwrap();
    let document = br#"{"version":1,"profiles":{"custom-main:default":{"type":"api_key","provider":"custom-main","keyRef":{"source":"env","provider":"custom-main","id":"CUSTOM_MAIN_API_KEY"}}}}"#;
    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(document.to_vec()).unwrap(),
        )
        .unwrap();
    let reference = environment::CredentialReference::try_new("credential:v1:custom-main").unwrap();

    assert!(credential_is_available(&root.state_dir, "custom-main", &reference, 1_999).unwrap());
}

#[test]
fn malformed_oauth_profile_fails_closed_without_exposing_profile_contents() {
    let root = TestRoot::new();
    let agent = AgentId::try_new("main".into()).unwrap();
    let malformed = br#"{"version":1,"profiles":{"openai:oauth":{"type":"oauth","provider":"openai","access":"access","refresh":"refresh","expires":"invalid"}}}"#;
    root.state_dir
        .replace_auth_profiles(
            &agent,
            &PrivateAuthProfiles::try_new(malformed.to_vec()).unwrap(),
        )
        .unwrap();
    let reference =
        environment::CredentialReference::try_new("credential:v1:openai:oauth").unwrap();

    let error = credential_is_available(&root.state_dir, "openai", &reference, 1_999).unwrap_err();

    assert_eq!(error, AuthProjectionError::InvalidPersistedAuthProfiles);
    assert!(!format!("{error:?} {error}").contains("access"));
}
