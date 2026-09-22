use super::{FLEET_SECRET_REF_SCHEME, FleetSecretRef, FleetSecretRefError};

#[test]
fn parses_and_serializes_a_canonical_remote_fleet_reference() {
    let reference =
        FleetSecretRef::parse("  remote-fleet://production/openclaw.api-key  ").unwrap();

    assert_eq!(
        reference.as_str(),
        "remote-fleet://production/openclaw.api-key"
    );
    assert_eq!(reference.to_string(), "remote-fleet://<private>");
    assert_eq!(format!("{reference:?}"), "FleetSecretRef(<private>)");
    assert_eq!(
        reference.into_serialized(),
        "remote-fleet://production/openclaw.api-key"
    );
}

#[test]
fn accepts_only_the_remote_fleet_namespace_and_safe_path_segments() {
    for value in [
        "remote-fleet://a",
        "remote-fleet://production/agent_1",
        "remote-fleet://production/agent-1/runtime.v2",
    ] {
        assert!(FleetSecretRef::try_from(value).is_ok(), "{value}");
    }

    for value in [
        "fleet-secret",
        "https://production/credential",
        "remote-fleet://",
        "remote-fleet:///credential",
        "remote-fleet://production//credential",
        "remote-fleet://production/../credential",
        "remote-fleet://production/credential?query",
        "remote-fleet://production/.credential",
    ] {
        assert!(FleetSecretRef::try_from(value).is_err(), "{value}");
    }
}

#[test]
fn rejects_invalid_references_without_echoing_their_contents() {
    let sentinel = "fleet-secret-canary-value";
    let missing_namespace = FleetSecretRef::parse(sentinel).unwrap_err();
    let unsupported_namespace = FleetSecretRef::parse(&format!("https://{sentinel}")).unwrap_err();
    let invalid_path =
        FleetSecretRef::parse(&format!("{FLEET_SECRET_REF_SCHEME}{sentinel}//next")).unwrap_err();

    assert_eq!(missing_namespace, FleetSecretRefError::MissingNamespace);
    assert_eq!(
        unsupported_namespace,
        FleetSecretRefError::UnsupportedNamespace
    );
    assert_eq!(invalid_path, FleetSecretRefError::InvalidPath);
    for error in [missing_namespace, unsupported_namespace, invalid_path] {
        assert!(!format!("{error:?} {error}").contains(sentinel));
    }
}

#[test]
fn rejects_paths_longer_than_the_durable_reference_limit() {
    let path = "a".repeat(257);

    assert_eq!(
        FleetSecretRef::parse(&format!("{FLEET_SECRET_REF_SCHEME}{path}")),
        Err(FleetSecretRefError::InvalidPath)
    );
}
