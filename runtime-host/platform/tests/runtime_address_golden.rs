use platform::endpoint::runtime_address::{RuntimeEndpoint, RuntimeScope, SessionIdentity};

fn endpoint() -> RuntimeEndpoint {
    RuntimeEndpoint::try_new("openclaw", "local").unwrap()
}

fn identity() -> SessionIdentity {
    SessionIdentity::try_new(endpoint(), "agent:primary", "session:primary").unwrap()
}

#[test]
fn canonical_runtime_address_vectors_match_electron_projection() {
    assert_eq!(
        endpoint().canonical_key(),
        r#"{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"}"#
    );
    assert_eq!(
        identity().canonical_key(),
        r#"{"type":"session-identity","endpoint":{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"},"agentId":"agent:primary","sessionKey":"session:primary"}"#
    );
    assert_eq!(
        RuntimeScope::workspace(endpoint(), "workspace:primary", "source:primary")
            .unwrap()
            .canonical_key(),
        r#"{"type":"runtime-scope","kind":"workspace","endpoint":{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"},"workspaceId":"workspace:primary","sourceId":"source:primary"}"#
    );
}

#[test]
fn structured_keys_do_not_collide_when_component_boundaries_differ() {
    let first = RuntimeEndpoint::try_new("a:b", "c").unwrap();
    let second = RuntimeEndpoint::try_new("a", "b:c").unwrap();

    assert_ne!(first, second);
    assert_ne!(first.canonical_key(), second.canonical_key());
}

#[test]
fn invalid_identities_are_rejected_without_echoing_values() {
    for invalid in [" \t\n", "secret\0value"] {
        let error = RuntimeEndpoint::try_new(invalid, "local").unwrap_err();
        assert_eq!(error.to_string(), "runtime address identity is invalid");
        assert!(!format!("{error:?}").contains(invalid));
    }
    let secret_endpoint = RuntimeEndpoint::try_new("secret-adapter", "secret-instance").unwrap();
    assert!(!format!("{secret_endpoint:?}").contains("secret-adapter"));
    let secret_identity =
        SessionIdentity::try_new(secret_endpoint, "agent:primary", "secret-session-key").unwrap();
    assert!(!format!("{secret_identity:?}").contains("secret-session-key"));
    assert!(!format!("{:?}", identity()).contains("session:primary"));
}

#[test]
fn scope_containment_is_endpoint_bound_and_workspace_exact() {
    let contained = identity();
    let other_endpoint = SessionIdentity::try_new(
        RuntimeEndpoint::try_new("matcha-agent", "local").unwrap(),
        "agent:primary",
        "session:primary",
    )
    .unwrap();
    let workspace =
        RuntimeScope::workspace(endpoint(), "workspace:primary", "source:primary").unwrap();

    assert!(workspace.contains_session(&contained));
    assert!(!workspace.contains_session(&other_endpoint));
    assert!(workspace.contains_workspace(
        contained.endpoint(),
        "workspace:primary",
        "source:primary",
        &contained,
    ));
    assert!(!workspace.contains_workspace(
        contained.endpoint(),
        "workspace:other",
        "source:primary",
        &contained,
    ));
    assert!(!workspace.contains_workspace(
        contained.endpoint(),
        "workspace:primary",
        "source:other",
        &contained,
    ));
}
