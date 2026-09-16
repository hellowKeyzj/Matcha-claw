use super::*;

fn credential() -> CredentialReference {
    CredentialReference::try_new("credential:v1:provider-account-private").unwrap()
}

fn account(id: &str, provider: &str) -> ProviderAccount {
    ProviderAccount::new(
        ProviderAccountId::try_new(id).unwrap(),
        ProviderReference::try_new(provider).unwrap(),
        ProviderAccountRevision::try_new(1).unwrap(),
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Primary".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(ProviderEndpoint::try_new("https://api.example.com/v1").unwrap()),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::ApiKey,
            credential: Some(credential()),
            created_at: "2026-07-27T10:00:00Z".to_owned(),
            updated_at: "2026-07-27T10:00:00Z".to_owned(),
        })
        .unwrap(),
    )
}

#[test]
fn account_keeps_only_non_secret_identity_configuration_and_opaque_credential_reference() {
    let account = account("openai-primary", "provider:openai");

    assert_eq!(account.id().as_str(), "openai-primary");
    assert_eq!(account.provider().as_str(), "provider:openai");
    assert_eq!(account.revision().get(), 1);
    assert_eq!(account.configuration().label(), "Primary");
    assert_eq!(
        account.configuration().credential().unwrap().as_str(),
        "credential:v1:provider-account-private"
    );
    assert!(!format!("{account:?}").contains("provider-account-private"));
}

#[test]
fn account_configuration_rejects_secret_bearing_or_ambiguous_public_values() {
    assert_eq!(
        ProviderEndpoint::try_new("https://user:secret-canary@api.example.com/v1"),
        Err(InvalidProviderEndpoint)
    );
    assert!(ProviderEndpoint::try_new("https://api.example.com/v1?region=us#models").is_ok());
    assert_eq!(
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Primary".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: None,
            protocol: None,
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::ApiKey,
            credential: None,
            created_at: "2026-07-27T10:00:00Z".to_owned(),
            updated_at: "2026-07-27T10:00:00Z".to_owned(),
        }),
        Err(InvalidProviderAccountConfiguration::CredentialRequired)
    );
    assert_eq!(
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Primary".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: None,
            protocol: None,
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::Local,
            credential: Some(credential()),
            created_at: "2026-07-27T10:00:00Z".to_owned(),
            updated_at: "2026-07-27T10:00:00Z".to_owned(),
        }),
        Err(InvalidProviderAccountConfiguration::LocalCredential)
    );
}

#[test]
fn media_configuration_requires_a_media_protocol_and_preserves_non_secret_timestamps() {
    let configuration = ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
        label: "Media".to_owned(),
        enabled: false,
        kind: ProviderAccountKind::Media,
        endpoint: Some(ProviderEndpoint::try_new("https://api.example.com/v1").unwrap()),
        protocol: None,
        media_protocol: Some(ProviderMediaApiProtocol::OpenAi),
        auth_mode: ProviderAccountAuthMode::ApiKey,
        credential: Some(credential()),
        created_at: "2026-07-27T09:00:00Z".to_owned(),
        updated_at: "2026-07-27T11:00:00Z".to_owned(),
    })
    .unwrap();

    assert_eq!(configuration.kind(), ProviderAccountKind::Media);
    assert_eq!(
        configuration.media_protocol(),
        Some(ProviderMediaApiProtocol::OpenAi)
    );
    assert_eq!(configuration.created_at(), "2026-07-27T09:00:00Z");
    assert_eq!(configuration.updated_at(), "2026-07-27T11:00:00Z");
}

#[test]
fn selection_is_explicit_and_never_infers_an_account_from_provider_order() {
    let accounts = [
        account("openai-secondary", "provider:openai"),
        account("openai-primary", "provider:openai"),
    ];
    let selection = ProviderAccountSelection::new(
        ProviderReference::try_new("provider:openai").unwrap(),
        ProviderAccountId::try_new("openai-primary").unwrap(),
    );

    assert_eq!(
        selection.select(&accounts).unwrap().id().as_str(),
        "openai-primary"
    );
    assert!(
        ProviderAccountSelection::new(
            ProviderReference::try_new("provider:openai").unwrap(),
            ProviderAccountId::try_new("missing").unwrap(),
        )
        .select(&accounts)
        .is_none()
    );
}

#[test]
fn protocol_and_auth_mode_are_explicitly_enumerated_without_open_metadata() {
    let configuration = ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
        label: "OpenAI".to_owned(),
        enabled: true,
        kind: ProviderAccountKind::Chat,
        endpoint: None,
        protocol: Some(ProviderApiProtocol::OpenAiCompletions),
        media_protocol: None,
        auth_mode: ProviderAccountAuthMode::OAuthBrowser,
        credential: Some(credential()),
        created_at: "2026-07-27T10:00:00Z".to_owned(),
        updated_at: "2026-07-27T10:00:00Z".to_owned(),
    })
    .unwrap();

    assert_eq!(
        configuration.protocol(),
        Some(ProviderApiProtocol::OpenAiCompletions)
    );
    assert_eq!(
        configuration.auth_mode(),
        ProviderAccountAuthMode::OAuthBrowser
    );
}
