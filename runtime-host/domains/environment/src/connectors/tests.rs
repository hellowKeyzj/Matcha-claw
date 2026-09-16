use std::collections::BTreeMap;

use super::*;

#[test]
fn valid_secret_references_validate() {
    let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
    input.url = Some("https://example.test/mcp".into());
    let connector = Connector::new(input).with_secret_references(
        None,
        Some(BTreeMap::from([(
            "Authorization".into(),
            "credential:v1:opaque".into(),
        )])),
        None,
    );

    assert!(connector.validate().is_ok());
    assert!(connector.has_secret_references());
    assert_eq!(
        connector.secret_header_references().collect::<Vec<_>>(),
        vec![("Authorization", "credential:v1:opaque")]
    );
}

#[test]
fn secret_reference_maps_reject_invalid_keys_and_values() {
    let invalid = [
        ("", "credential:v1:opaque"),
        ("Authorization", ""),
        ("Authorization", "credential secret"),
        ("Authorization", "credential:v1:opaque\n"),
    ];
    for (key, reference) in invalid {
        let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpHttp);
        input.url = Some("https://example.test/mcp".into());
        let connector = Connector::new(input).with_secret_references(
            None,
            Some(BTreeMap::from([(key.to_owned(), reference.to_owned())])),
            None,
        );
        assert_eq!(connector.validate(), Err(ConnectorError::Invalid));
    }

    let mut input = ConnectorInput::new("remote".into(), ConnectorKind::McpStdio);
    input.command = Some("managed-mcp".into());
    let connector = Connector::new(input).with_secret_references(
        Some(BTreeMap::from([(
            "lowercase".into(),
            "credential:v1:opaque".into(),
        )])),
        None,
        None,
    );
    assert_eq!(connector.validate(), Err(ConnectorError::Invalid));
}

#[test]
fn system_connector_cannot_mutate_or_delete() {
    let mut catalog = ConnectorCatalog::default();
    assert_eq!(
        catalog.upsert(Connector::system_runtime()),
        Err(ConnectorError::SystemManaged)
    );
    assert_eq!(catalog.remove("matcha"), Err(ConnectorError::SystemManaged));
}
