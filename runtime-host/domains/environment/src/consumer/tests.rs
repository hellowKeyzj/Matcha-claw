use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, UNIX_EPOCH},
};

use serde_json::json;

use super::*;
use crate::{
    BrowserMode, ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, EnvironmentAuthorizationAuthority, EnvironmentCommand, EnvironmentId,
    EnvironmentProvenance, EnvironmentRevision, ExtensionReference, PolicyReference, PolicyVersion,
    ProviderReference, SecurityPreset, StoreFault, ToolchainReference,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> std::path::PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("matcha-environment-consumer-{name}-{id}"))
}

fn definition(revision: u64, preset: SecurityPreset) -> DesiredDefinition {
    DesiredDefinition::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(revision).unwrap(),
        ProviderReference::try_new("provider:anthropic").unwrap(),
        DesiredConfiguration::try_new(
            vec![ConnectorReference::try_new("connector:slack").unwrap()],
            vec![ExtensionReference::try_new("extension:browser").unwrap()],
            vec![ChannelReference::try_new("channel:discord").unwrap()],
            vec![CredentialReference::try_new("credential:v1:reference-only").unwrap()],
            vec![PolicyReference::try_new("policy:balanced").unwrap()],
            vec![ToolchainReference::try_new("toolchain:bun").unwrap()],
            preset,
            BrowserMode::Relay,
            Vec::new(),
        )
        .unwrap(),
    )
}

fn wire_definition(definition: &DesiredDefinition) -> serde_json::Value {
    json!({
        "environmentId": definition.environment_id().as_str(),
        "revision": definition.revision().get(),
        "provider": definition.provider().as_str(),
        "configuration": {
            "connectors": definition.connectors().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "extensions": definition.extensions().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "channels": definition.channels().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "credentialReferences": definition.credential_references().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "policies": definition.policies().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "toolchains": definition.toolchains().iter().map(|reference| reference.as_str()).collect::<Vec<_>>(),
            "securityPreset": match definition.security_preset() {
                SecurityPreset::Strict => "strict",
                SecurityPreset::Balanced => "balanced",
                SecurityPreset::Relaxed => "relaxed",
            },
            "browserMode": "relay",
            "operationalChannels": [],
        }
    })
}

fn envelope(
    authority: &mut EnvironmentAuthorizationAuthority,
    command: &EnvironmentCommand,
    nonce: &str,
) -> Vec<u8> {
    let principal = crate::EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let provenance = EnvironmentProvenance::try_new("correlation:security-change").unwrap();
    let grant = authority
        .grant(
            &principal,
            command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    let command = match command {
        EnvironmentCommand::Create(create) => json!({
            "kind": "create",
            "definition": wire_definition(create.definition()),
        }),
        EnvironmentCommand::Replace(replace) => json!({
            "kind": "replace",
            "environmentId": replace.environment_id().as_str(),
            "expectedRevision": replace.expected_revision().get(),
            "definition": wire_definition(replace.definition()),
        }),
        EnvironmentCommand::Delete(delete) => json!({
            "kind": "delete",
            "environmentId": delete.environment_id().as_str(),
            "expectedRevision": delete.expected_revision().get(),
        }),
    };
    serde_json::to_vec(&json!({
        "version": 1,
        "actor": principal.as_str(),
        "authorization": {
            "grantId": grant.grant_id(),
            "proof": grant.authorization().proof(),
            "expiresAt": 60_u64,
        },
        "provenance": provenance.as_str(),
        "nonce": nonce,
        "command": command,
    }))
    .unwrap()
}

#[test]
fn post_authorization_commit_unknown_is_not_retryable() {
    assert_eq!(
        EnvironmentDesiredFailure::after_authorization(StoreFault::CommitOutcomeUnknown(
            std::io::ErrorKind::Other,
        )),
        EnvironmentDesiredFailure::RetryUnsafeAfterAuthorization
    );
}

#[test]
fn authorized_security_desired_is_durably_stored_and_reconciliation_requires_projection() {
    let root = path("security");
    let authority_path = root.join("authority.log");
    let store_path = root.join("desired.log");
    let mut authority = EnvironmentAuthorizationAuthority::open(&authority_path).unwrap();
    let create = EnvironmentCommand::create(definition(1, SecurityPreset::Strict)).unwrap();
    let input = envelope(&mut authority, &create, "nonce:create");
    let mut consumer = EnvironmentDesiredConsumer::open(authority, &store_path).unwrap();

    let receipt = consumer
        .accept(
            &input,
            RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap(),
            UNIX_EPOCH,
        )
        .unwrap();

    assert_eq!(receipt.environment_id(), "environment:primary");
    assert_eq!(receipt.revision().get(), 1);
    assert_eq!(receipt.security_preset(), Some(SecurityPreset::Strict));
    assert_eq!(
        receipt.reconciliation().unwrap().state(),
        crate::EnvironmentReconciliationState::ProjectionRequired
    );
    assert_eq!(
        receipt.reconciliation().unwrap().actions(),
        &[
            crate::EnvironmentReconciliationAction::ApplyDesiredRevision {
                revision: EnvironmentRevision::try_new(1).unwrap()
            }
        ]
    );
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert_eq!(
        reopened
            .environment(&EnvironmentId::try_new("environment:primary").unwrap())
            .unwrap()
            .desired()
            .security_preset(),
        SecurityPreset::Strict
    );
    drop(reopened);
    let _ = fs::remove_file(authority_path);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn authorized_replace_advances_the_existing_security_desired_revision() {
    let root = path("replace");
    let authority_path = root.join("authority.log");
    let store_path = root.join("desired.log");
    let mut authority = EnvironmentAuthorizationAuthority::open(&authority_path).unwrap();
    let create = EnvironmentCommand::create(definition(1, SecurityPreset::Balanced)).unwrap();
    let create_input = envelope(&mut authority, &create, "nonce:create");
    let replace = EnvironmentCommand::replace(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(1).unwrap(),
        definition(2, SecurityPreset::Strict),
    )
    .unwrap();
    let replace_input = envelope(&mut authority, &replace, "nonce:replace");
    let mut consumer = EnvironmentDesiredConsumer::open(authority, &store_path).unwrap();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();

    consumer
        .accept(&create_input, scope.clone(), UNIX_EPOCH)
        .unwrap();
    let receipt = consumer.accept(&replace_input, scope, UNIX_EPOCH).unwrap();

    assert_eq!(receipt.revision(), EnvironmentRevision::try_new(2).unwrap());
    assert_eq!(receipt.security_preset(), Some(SecurityPreset::Strict));
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    let facts = reopened
        .environment(&EnvironmentId::try_new("environment:primary").unwrap())
        .unwrap();
    assert_eq!(
        facts.desired_revision(),
        EnvironmentRevision::try_new(2).unwrap()
    );
    assert_eq!(facts.desired().security_preset(), SecurityPreset::Strict);
    drop(reopened);
    let _ = fs::remove_file(authority_path);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn authorized_delete_tombstones_durably_without_a_reconciliation_receipt() {
    let root = path("delete");
    let authority_path = root.join("authority.log");
    let store_path = root.join("desired.log");
    let mut authority = EnvironmentAuthorizationAuthority::open(&authority_path).unwrap();
    let create = EnvironmentCommand::create(definition(1, SecurityPreset::Balanced)).unwrap();
    let create_input = envelope(&mut authority, &create, "nonce:create");
    let delete = EnvironmentCommand::delete(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(1).unwrap(),
    );
    let delete_input = envelope(&mut authority, &delete, "nonce:delete");
    let mut consumer = EnvironmentDesiredConsumer::open(authority, &store_path).unwrap();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();

    consumer
        .accept(&create_input, scope.clone(), UNIX_EPOCH)
        .unwrap();
    let receipt = consumer.accept(&delete_input, scope, UNIX_EPOCH).unwrap();
    assert_eq!(receipt.environment_id(), "environment:primary");
    assert_eq!(receipt.revision(), EnvironmentRevision::try_new(1).unwrap());
    assert_eq!(receipt.security_preset(), None);
    assert_eq!(receipt.reconciliation(), None);
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    let facts = reopened
        .environment(&EnvironmentId::try_new("environment:primary").unwrap())
        .unwrap();
    assert!(facts.is_tombstone());
    assert!(facts.applied().is_none());
    drop(reopened);
    let _ = fs::remove_file(authority_path);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}

#[test]
fn strict_ingress_rejects_replay_and_tampered_desired_before_store_mutation() {
    let root = path("replay");
    let authority_path = root.join("authority.log");
    let store_path = root.join("desired.log");
    let mut authority = EnvironmentAuthorizationAuthority::open(&authority_path).unwrap();
    let create = EnvironmentCommand::create(definition(1, SecurityPreset::Balanced)).unwrap();
    let input = envelope(&mut authority, &create, "nonce:one");
    let mut consumer = EnvironmentDesiredConsumer::open(authority, &store_path).unwrap();
    let scope = RuntimeObservationScope::try_new("scope:openclaw-primary").unwrap();

    consumer.accept(&input, scope.clone(), UNIX_EPOCH).unwrap();
    assert_eq!(
        consumer.accept(&input, scope.clone(), UNIX_EPOCH),
        Err(EnvironmentDesiredFailure::Ingress(
            EnvironmentIngressFailure::ReplayRejected
        ))
    );
    let mut tampered: serde_json::Value = serde_json::from_slice(&input).unwrap();
    tampered["command"]["definition"]["configuration"]["securityPreset"] = json!("relaxed");
    tampered["nonce"] = json!("nonce:two");
    assert_eq!(
        consumer.accept(&serde_json::to_vec(&tampered).unwrap(), scope, UNIX_EPOCH,),
        Err(EnvironmentDesiredFailure::Ingress(
            EnvironmentIngressFailure::AuthorizationDenied
        ))
    );
    let reopened = EnvironmentStore::open(&store_path).unwrap();
    assert_eq!(reopened.facts().len(), 1);
    assert_eq!(
        reopened.facts()[0].desired().security_preset(),
        SecurityPreset::Balanced
    );
    drop(reopened);
    let _ = fs::remove_file(authority_path);
    let _ = fs::remove_file(store_path);
    let _ = fs::remove_dir(root);
}
