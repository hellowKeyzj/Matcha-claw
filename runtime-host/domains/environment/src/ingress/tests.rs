use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::json;

use super::*;
use crate::EnvironmentCommand;

#[derive(Default)]
struct AuthorizationFixture {
    accepted: HashSet<String>,
    rejection: Option<EnvironmentAuthorizationRejection<()>>,
    observed: Option<(String, String, String, String, String)>,
}

impl EnvironmentAuthorizationPort for AuthorizationFixture {
    type Error = ();

    fn authorize(
        &mut self,
        principal: &EnvironmentPrincipal,
        authorization: &EnvironmentAuthorization,
        provenance: &EnvironmentProvenance,
        nonce: &EnvironmentNonce,
        command: &EnvironmentCommand,
        _now: SystemTime,
    ) -> Result<(), EnvironmentAuthorizationRejection<Self::Error>> {
        self.observed = Some((
            principal.as_str().to_owned(),
            authorization.grant_id().to_owned(),
            provenance.as_str().to_owned(),
            nonce.as_str().to_owned(),
            command.environment_id().as_str().to_owned(),
        ));
        if let Some(rejection) = self.rejection.take() {
            return Err(rejection);
        }
        let is_expected_command = matches!(
            command,
            EnvironmentCommand::Create(definition)
                if definition.definition().provider().as_str() == "provider:anthropic"
        );
        if principal.as_str() != "actor:primary"
            || authorization.grant_id() != "grant:environment-write"
            || authorization.proof() != "proof:opaque"
            || provenance.as_str() != "correlation:request-1"
            || !is_expected_command
        {
            return Err(EnvironmentAuthorizationRejection::Denied);
        }
        if !self.accepted.insert(nonce.as_str().to_owned()) {
            return Err(EnvironmentAuthorizationRejection::Replay);
        }
        Ok(())
    }
}

fn envelope() -> serde_json::Value {
    json!({
        "version": 1,
        "actor": "actor:primary",
        "authorization": { "grantId": "grant:environment-write", "proof": "proof:opaque", "expiresAt": 4_102_444_800_u64 },
        "provenance": "correlation:request-1",
        "nonce": "nonce:one",
        "command": {
            "kind": "create",
            "definition": {
                "environmentId": "environment:primary",
                "revision": 1,
                "provider": "provider:anthropic",
                "configuration": {
                    "connectors": ["connector:slack"],
                    "extensions": ["extension:browser"],
                    "channels": ["channel:discord"],
                    "credentialReferences": ["credential:v1:reference-only"],
                    "policies": ["policy:balanced"],
                    "toolchains": ["toolchain:bun"],
                    "securityPreset": "balanced",
                    "browserMode": "relay",
                    "operationalChannels": [{
                        "channel": "channel:discord",
                        "account": "default",
                        "enabled": true,
                        "directMessagePolicy": "pairing"
                    }]
                }
            }
        }
    })
}

#[test]
fn valid_authorized_create_yields_only_the_existing_domain_command() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
    let command = ingress
        .accept(envelope().to_string().as_bytes(), UNIX_EPOCH)
        .unwrap();

    assert!(matches!(command, EnvironmentCommand::Create(_)));
    assert_eq!(command.environment_id().as_str(), "environment:primary");
    assert_eq!(command.definition().unwrap().revision().get(), 1);
    assert_eq!(
        ingress.authorization().observed,
        Some((
            "actor:primary".into(),
            "grant:environment-write".into(),
            "correlation:request-1".into(),
            "nonce:one".into(),
            "environment:primary".into(),
        ))
    );
    assert_eq!(
        EnvironmentCommandEnvelope::decode(envelope().to_string().as_bytes())
            .unwrap()
            .command(),
        &command
    );
}

#[test]
fn envelope_decodes_replace_and_delete_commands_with_camel_case_fields() {
    let mut replace = envelope();
    replace["command"] = json!({
        "kind": "replace",
        "environmentId": "environment:primary",
        "expectedRevision": 1,
        "definition": {
            "environmentId": "environment:primary",
            "revision": 2,
            "provider": "provider:anthropic",
            "configuration": envelope()["command"]["definition"]["configuration"].clone()
        }
    });
    let replace = EnvironmentCommandEnvelope::decode(replace.to_string().as_bytes()).unwrap();
    assert!(matches!(replace.command(), EnvironmentCommand::Replace(_)));
    assert_eq!(replace.command().expected_revision().unwrap().get(), 1);
    assert_eq!(replace.command().definition().unwrap().revision().get(), 2);

    let delete = json!({
        "version": 1,
        "actor": "actor:primary",
        "authorization": { "grantId": "grant:environment-write", "proof": "proof:opaque", "expiresAt": 4_102_444_800_u64 },
        "provenance": "correlation:request-1",
        "nonce": "nonce:delete",
        "command": {
            "kind": "delete",
            "environmentId": "environment:primary",
            "expectedRevision": 2
        }
    });
    let delete = EnvironmentCommandEnvelope::decode(delete.to_string().as_bytes()).unwrap();
    assert!(matches!(delete.command(), EnvironmentCommand::Delete(_)));
    assert_eq!(delete.command().expected_revision().unwrap().get(), 2);
}

#[test]
fn envelope_validation_is_versioned_strict_and_non_secret() {
    let mut cases = [json!({}), envelope(), envelope(), envelope(), envelope()];
    cases[1]["version"] = json!(2);
    cases[2]["authorization"]["proof"] = json!(" ");
    cases[3]["command"]["definition"]["configuration"]["credentialReferences"] =
        json!(["credential:v1:a", "credential:v1:a"]);
    cases[4]["secret"] = json!("secret-canary-must-not-escape");

    assert_eq!(
        EnvironmentCommandEnvelope::decode(cases[0].to_string().as_bytes()),
        Err(EnvironmentIngressFailure::InvalidEnvelope)
    );
    assert_eq!(
        EnvironmentCommandEnvelope::decode(cases[1].to_string().as_bytes()),
        Err(EnvironmentIngressFailure::UnsupportedVersion)
    );
    assert_eq!(
        EnvironmentCommandEnvelope::decode(cases[2].to_string().as_bytes()),
        Err(EnvironmentIngressFailure::InvalidEnvelope)
    );
    assert_eq!(
        EnvironmentCommandEnvelope::decode(cases[3].to_string().as_bytes()),
        Err(EnvironmentIngressFailure::InvalidEnvelope)
    );
    let error = EnvironmentCommandEnvelope::decode(cases[4].to_string().as_bytes()).unwrap_err();
    assert_eq!(error, EnvironmentIngressFailure::InvalidEnvelope);
    assert!(!format!("{error:?} {error}").contains("secret-canary-must-not-escape"));
    assert_eq!(
        EnvironmentCommandEnvelope::decode(b"{\"version\":1,"),
        Err(EnvironmentIngressFailure::InvalidEnvelope)
    );
}

#[test]
fn authorization_rejections_fail_closed_without_exposing_actor_grant_or_proof() {
    let cases = [
        (
            EnvironmentAuthorizationRejection::Denied,
            EnvironmentIngressFailure::AuthorizationDenied,
        ),
        (
            EnvironmentAuthorizationRejection::Expired,
            EnvironmentIngressFailure::AuthorizationExpired,
        ),
        (
            EnvironmentAuthorizationRejection::Revoked,
            EnvironmentIngressFailure::AuthorizationRevoked,
        ),
        (
            EnvironmentAuthorizationRejection::Unavailable(()),
            EnvironmentIngressFailure::AuthorizationUnavailable,
        ),
    ];

    for (rejection, expected) in cases {
        let mut ingress = EnvironmentIngress::new(AuthorizationFixture {
            rejection: Some(rejection),
            ..AuthorizationFixture::default()
        });
        let error = ingress
            .accept(
                envelope().to_string().as_bytes(),
                UNIX_EPOCH + Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        let rendered = format!("{error:?} {error}");
        for secret in [
            "actor:primary",
            "grant:environment-write",
            "proof:opaque",
            "credential:v1:reference-only",
        ] {
            assert!(!rendered.contains(secret));
        }
    }
}

#[test]
fn replay_is_rejected_by_the_external_authority_before_a_second_command_can_escape() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
    let input = envelope().to_string();

    assert!(ingress.accept(input.as_bytes(), UNIX_EPOCH).is_ok());
    assert_eq!(
        ingress.accept(input.as_bytes(), UNIX_EPOCH).unwrap_err(),
        EnvironmentIngressFailure::ReplayRejected
    );
}

#[test]
fn envelope_expiry_is_rejected_before_the_external_authority_or_command_consumer() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
    let mut input = envelope();
    input["authorization"]["expiresAt"] = json!(1);

    assert_eq!(
        ingress
            .accept(
                input.to_string().as_bytes(),
                UNIX_EPOCH + Duration::from_secs(1)
            )
            .unwrap_err(),
        EnvironmentIngressFailure::AuthorizationExpired
    );
    assert!(ingress.authorization().observed.is_none());
}

#[test]
fn wrong_actor_or_grant_cannot_consume_a_nonce_or_yield_a_command() {
    for (field, value) in [
        ("actor", json!("actor:other")),
        ("authorization.grantId", json!("grant:other")),
    ] {
        let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
        let mut input = envelope();
        match field {
            "actor" => input["actor"] = value,
            "authorization.grantId" => input["authorization"]["grantId"] = value,
            _ => unreachable!(),
        }

        assert_eq!(
            ingress
                .accept(input.to_string().as_bytes(), UNIX_EPOCH)
                .unwrap_err(),
            EnvironmentIngressFailure::AuthorizationDenied
        );
        assert!(ingress.authorization().accepted.is_empty());
    }
}

#[test]
fn stale_replace_revision_is_rejected_before_authorization_or_nonce_consumption() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
    let mut input = envelope();
    input["command"] = json!({
        "kind": "replace",
        "environmentId": "environment:primary",
        "expectedRevision": 4,
        "definition": {
            "environmentId": "environment:primary",
            "revision": 4,
            "provider": "provider:anthropic",
            "configuration": input["command"]["definition"]["configuration"].clone()
        }
    });

    assert_eq!(
        ingress
            .accept(input.to_string().as_bytes(), UNIX_EPOCH)
            .unwrap_err(),
        EnvironmentIngressFailure::InvalidEnvelope
    );
    assert!(ingress.authorization().observed.is_none());
    assert!(ingress.authorization().accepted.is_empty());
}

#[test]
fn unavailable_authorization_leaves_the_nonce_unconsumed_for_the_trusted_authority() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture {
        rejection: Some(EnvironmentAuthorizationRejection::Unavailable(())),
        ..AuthorizationFixture::default()
    });
    let input = envelope().to_string();

    assert_eq!(
        ingress.accept(input.as_bytes(), UNIX_EPOCH).unwrap_err(),
        EnvironmentIngressFailure::AuthorizationUnavailable
    );
    assert!(ingress.authorization().accepted.is_empty());
    assert!(ingress.authorization().observed.is_some());
}

#[test]
fn tampering_changes_the_verified_command_and_cannot_bypass_the_authority() {
    let mut ingress = EnvironmentIngress::new(AuthorizationFixture::default());
    let mut input = envelope();
    input["command"]["definition"]["provider"] = json!("provider:tampered");

    assert_eq!(
        ingress
            .accept(input.to_string().as_bytes(), UNIX_EPOCH)
            .unwrap_err(),
        EnvironmentIngressFailure::AuthorizationDenied
    );
    assert_eq!(
        ingress.authorization().observed.as_ref().unwrap().4,
        "environment:primary"
    );
}

#[test]
fn authorization_and_envelope_debug_never_print_proof_or_credential_reference() {
    let envelope = EnvironmentCommandEnvelope::decode(envelope().to_string().as_bytes()).unwrap();
    let rendered = format!("{envelope:?}");
    assert!(!rendered.contains("proof:opaque"));
    assert!(!rendered.contains("credential:v1:reference-only"));
}
