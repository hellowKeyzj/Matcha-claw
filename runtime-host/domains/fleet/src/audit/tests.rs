use std::collections::BTreeMap;

use super::{
    FleetAuditError, FleetAuditEvent, FleetAuditEventInput, FleetAuditValue, REDACTED_VALUE,
};

#[test]
fn creation_recursively_redacts_sensitive_metadata_and_secret_references() {
    let sentinel = "fleet-audit-secret-canary";
    let event = FleetAuditEvent::new(FleetAuditEventInput {
        event_name: "command.dispatch.requested".to_owned(),
        occurred_at: std::time::SystemTime::UNIX_EPOCH,
        message: Some(format!("authorization=Bearer {sentinel}")),
        relations: super::FleetAuditRelations::default(),
        metadata: BTreeMap::from([
            (
                "authorization".to_owned(),
                FleetAuditValue::Text(sentinel.to_owned()),
            ),
            (
                "nested".to_owned(),
                FleetAuditValue::Fields(BTreeMap::from([(
                    "credential".to_owned(),
                    FleetAuditValue::Text("remote-fleet://production/credential".to_owned()),
                )])),
            ),
            (
                "retries".to_owned(),
                FleetAuditValue::List(vec![
                    FleetAuditValue::Integer(2),
                    FleetAuditValue::Boolean(true),
                ]),
            ),
            (
                "apiKey".to_owned(),
                FleetAuditValue::Text(sentinel.to_owned()),
            ),
        ]),
    })
    .unwrap();

    assert_eq!(event.message(), Some(REDACTED_VALUE));
    assert_eq!(
        event.metadata().get("authorization"),
        Some(&FleetAuditValue::Text(REDACTED_VALUE.to_owned()))
    );
    assert_eq!(
        event.metadata().get("apiKey"),
        Some(&FleetAuditValue::Text(REDACTED_VALUE.to_owned()))
    );
    assert_eq!(
        event.metadata().get("nested"),
        Some(&FleetAuditValue::Fields(BTreeMap::from([(
            "credential".to_owned(),
            FleetAuditValue::Text(REDACTED_VALUE.to_owned()),
        )])))
    );
    assert!(!format!("{event:?}").contains(sentinel));
}

#[test]
fn redacts_for_commit_again_before_durable_persistence() {
    let event = FleetAuditEvent::new(FleetAuditEventInput {
        event_name: "command.dispatch.completed".to_owned(),
        occurred_at: std::time::SystemTime::UNIX_EPOCH,
        message: Some("command completed".to_owned()),
        relations: super::FleetAuditRelations::default(),
        metadata: BTreeMap::from([(
            "result".to_owned(),
            FleetAuditValue::Text("accepted".to_owned()),
        )]),
    })
    .unwrap();

    let committed = event.redacted_for_commit();

    assert_eq!(committed, event);
    assert_eq!(committed.message(), Some("command completed"));
    assert_eq!(
        committed.metadata().get("result"),
        Some(&FleetAuditValue::Text("accepted".to_owned()))
    );
}

#[test]
fn blocks_sensitive_text_values_without_needing_untyped_json() {
    for value in [
        "--token fleet-audit-secret-canary",
        "Bearer fleet-audit-secret-canary",
        "mrf_fleetsecretcanary",
        "remote-fleet://production/credential",
    ] {
        let event = FleetAuditEvent::new(FleetAuditEventInput {
            event_name: "node.observed".to_owned(),
            occurred_at: std::time::SystemTime::UNIX_EPOCH,
            message: None,
            relations: super::FleetAuditRelations::default(),
            metadata: BTreeMap::from([(
                "detail".to_owned(),
                FleetAuditValue::Text(value.to_owned()),
            )]),
        })
        .unwrap();

        assert_eq!(
            event.metadata().get("detail"),
            Some(&FleetAuditValue::Text(REDACTED_VALUE.to_owned()))
        );
        assert!(!format!("{event:?}").contains("fleet-audit-secret-canary"));
    }
}

#[test]
fn reports_invalid_event_names_without_echoing_them() {
    let sentinel = "fleet-audit-secret-canary";
    let error = FleetAuditEvent::new(FleetAuditEventInput {
        event_name: format!("{sentinel}=value"),
        occurred_at: std::time::SystemTime::UNIX_EPOCH,
        message: None,
        relations: super::FleetAuditRelations::default(),
        metadata: BTreeMap::new(),
    })
    .unwrap_err();

    assert_eq!(error, FleetAuditError::InvalidEventName);
    assert!(!format!("{error:?} {error}").contains(sentinel));
}
