use std::{
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};

use super::*;
use crate::{
    BrowserMode, ChannelReference, ConnectorReference, CredentialReference, DesiredConfiguration,
    DesiredDefinition, EnvironmentAuthorizationRejection, EnvironmentCommand, EnvironmentId,
    EnvironmentNonce, EnvironmentPrincipal, EnvironmentProvenance, EnvironmentRevision,
    ExtensionReference, PolicyReference, ProviderReference, SecurityPreset, ToolchainReference,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn path(name: &str) -> std::path::PathBuf {
    let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "matcha-environment-authority-{}-{name}-{id}.log",
        std::process::id()
    ))
}

fn command(revision: u64) -> EnvironmentCommand {
    EnvironmentCommand::create(DesiredDefinition::new(
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
            SecurityPreset::Balanced,
            BrowserMode::Relay,
            Vec::new(),
        )
        .unwrap(),
    ))
    .unwrap()
}

#[test]
fn durable_grant_binds_actor_command_environment_revision_provenance_and_nonce() {
    let path = path("binding");
    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let grant = authority
        .grant(
            &principal,
            &command,
            EnvironmentProvenance::try_new("correlation:issue").unwrap(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(7).unwrap(),
        )
        .unwrap();
    let nonce = EnvironmentNonce::try_new("nonce:one").unwrap();

    authority
        .authorize(
            &principal,
            grant.authorization(),
            &EnvironmentProvenance::try_new("correlation:issue").unwrap(),
            &nonce,
            &command,
            UNIX_EPOCH,
        )
        .unwrap();
    assert_eq!(
        authority.authorize(
            &principal,
            grant.authorization(),
            &EnvironmentProvenance::try_new("correlation:issue").unwrap(),
            &nonce,
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Replay)
    );
    assert_eq!(
        authority.authorize(
            &principal,
            grant.authorization(),
            &EnvironmentProvenance::try_new("correlation:other").unwrap(),
            &EnvironmentNonce::try_new("nonce:two").unwrap(),
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Denied)
    );
    assert!(
        !std::fs::read(&path)
            .unwrap()
            .windows(grant.authorization().proof().len())
            .any(|window| window == grant.authorization().proof().as_bytes())
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn expiry_revocation_policy_change_and_restart_persistently_fail_closed() {
    let path = path("lifecycle");
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let provenance = EnvironmentProvenance::try_new("correlation:issue").unwrap();
    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    let expired = authority
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH,
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    assert_eq!(
        authority.authorize(
            &principal,
            expired.authorization(),
            &provenance,
            &EnvironmentNonce::try_new("nonce:expired").unwrap(),
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Expired)
    );

    let revoked = authority
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    authority.revoke(revoked.grant_id()).unwrap();
    drop(authority);

    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    assert_eq!(
        authority.authorize(
            &principal,
            revoked.authorization(),
            &provenance,
            &EnvironmentNonce::try_new("nonce:revoked").unwrap(),
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Revoked)
    );
    let current = PolicyVersion::try_new(2).unwrap();
    authority.set_policy_version(current).unwrap();
    let stale_policy = authority
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            current,
        )
        .unwrap();
    authority
        .set_policy_version(PolicyVersion::try_new(3).unwrap())
        .unwrap();
    assert_eq!(
        authority.authorize(
            &principal,
            stale_policy.authorization(),
            &provenance,
            &EnvironmentNonce::try_new("nonce:policy").unwrap(),
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Revoked)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn stale_temporary_record_cannot_override_the_last_committed_authority_state() {
    let path = path("stale-temporary");
    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let provenance = EnvironmentProvenance::try_new("correlation:issue").unwrap();
    let grant = authority
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    let nonce = EnvironmentNonce::try_new("nonce:temporary").unwrap();
    authority
        .authorize(
            &principal,
            grant.authorization(),
            &provenance,
            &nonce,
            &command,
            UNIX_EPOCH,
        )
        .unwrap();
    drop(authority);

    let temporary = std::path::PathBuf::from(format!("{}.next", path.display()));
    std::fs::write(&temporary, b"not-a-committed-authority-state").unwrap();
    let mut reopened = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    assert_eq!(
        reopened.authorize(
            &principal,
            grant.authorization(),
            &provenance,
            &nonce,
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Replay)
    );
    assert!(!temporary.exists());
    let _ = std::fs::remove_file(path);
}

#[test]
fn recovery_rejects_duplicate_grant_identity_before_redeeming_any_nonce() {
    let path = path("duplicate-grant-identity");
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let provenance = EnvironmentProvenance::try_new("correlation:issue").unwrap();
    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    authority
        .grant(
            &principal,
            &command,
            provenance,
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    drop(authority);

    let mut state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let duplicate = state["grants"].as_array().unwrap()[0].clone();
    state["grants"].as_array_mut().unwrap().push(duplicate);
    std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();

    assert!(matches!(
        EnvironmentAuthorizationAuthority::open(&path),
        Err(AuthorityStoreFault::InvalidRecord)
    ));
    let _ = std::fs::remove_file(path);
}

#[test]
fn replay_fence_survives_authority_restart() {
    let path = path("restart-replay");
    let mut authority = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let provenance = EnvironmentProvenance::try_new("correlation:issue").unwrap();
    let grant = authority
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    let nonce = EnvironmentNonce::try_new("nonce:restart").unwrap();
    authority
        .authorize(
            &principal,
            grant.authorization(),
            &provenance,
            &nonce,
            &command,
            UNIX_EPOCH,
        )
        .unwrap();
    drop(authority);

    let mut reopened = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    assert_eq!(
        reopened.authorize(
            &principal,
            grant.authorization(),
            &provenance,
            &nonce,
            &command,
            UNIX_EPOCH,
        ),
        Err(EnvironmentAuthorizationRejection::Replay)
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_nonce_redemption_is_linearized_and_exactly_one_succeeds() {
    let path = path("concurrent");
    let mut issuer = EnvironmentAuthorizationAuthority::open(&path).unwrap();
    let principal = EnvironmentPrincipal::try_new("actor:primary").unwrap();
    let command = command(1);
    let provenance = EnvironmentProvenance::try_new("correlation:issue").unwrap();
    let grant = issuer
        .grant(
            &principal,
            &command,
            provenance.clone(),
            UNIX_EPOCH + Duration::from_secs(60),
            PolicyVersion::try_new(1).unwrap(),
        )
        .unwrap();
    drop(issuer);

    let barrier = Arc::new(Barrier::new(2));
    let attempts = (0..2)
        .map(|_| {
            let path = path.clone();
            let principal = principal.clone();
            let authorization = grant.authorization().clone();
            let provenance = provenance.clone();
            let command = command.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                let mut authority = loop {
                    match EnvironmentAuthorizationAuthority::open(&path) {
                        Ok(authority) => break authority,
                        Err(AuthorityStoreFault::WriterBusy) => thread::yield_now(),
                        Err(error) => {
                            return Err(EnvironmentAuthorizationRejection::Unavailable(error));
                        }
                    }
                };
                loop {
                    match authority.authorize(
                        &principal,
                        &authorization,
                        &provenance,
                        &EnvironmentNonce::try_new("nonce:one").unwrap(),
                        &command,
                        UNIX_EPOCH,
                    ) {
                        Err(EnvironmentAuthorizationRejection::Unavailable(
                            AuthorityStoreFault::WriterBusy,
                        )) => thread::yield_now(),
                        result => return result,
                    }
                }
            })
        })
        .collect::<Vec<_>>();
    let results = attempts
        .into_iter()
        .map(|attempt| attempt.join().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(EnvironmentAuthorizationRejection::Replay)))
            .count(),
        1
    );
    let _ = std::fs::remove_file(path);
}
