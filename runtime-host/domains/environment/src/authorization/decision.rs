use std::{path::PathBuf, time::SystemTime};

use getrandom::fill;

use super::{
    AuthorityStoreFault, EnvironmentGrant, PolicyVersion,
    store::{
        AuthorityState, GrantRecord, command_digest, constant_time_matches, nonce_digest,
        open_state, proof_digest, refresh_state, unix_seconds,
    },
};
use crate::{
    EnvironmentAuthorization, EnvironmentAuthorizationPort, EnvironmentAuthorizationRejection,
    EnvironmentCommand, EnvironmentNonce, EnvironmentPrincipal, EnvironmentProvenance,
};

const RANDOM_BYTES: usize = 32;
const MAX_REDEEMED_NONCES: usize = 1_024;

pub struct EnvironmentAuthorizationAuthority {
    path: PathBuf,
    state: AuthorityState,
}

impl EnvironmentAuthorizationAuthority {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, AuthorityStoreFault> {
        let path = path.into();
        let state = open_state(&path)?;
        Ok(Self { path, state })
    }

    pub fn grant(
        &mut self,
        principal: &EnvironmentPrincipal,
        command: &EnvironmentCommand,
        provenance: EnvironmentProvenance,
        expires_at: SystemTime,
        policy_version: PolicyVersion,
    ) -> Result<EnvironmentGrant, AuthorityStoreFault> {
        let _lock = super::store::lock(&self.path)?;
        self.state = refresh_state(&self.path)?;
        match self.state.policy_version()? {
            Some(current) if current != policy_version => {
                return Err(AuthorityStoreFault::PolicyVersionConflict);
            }
            None => self.state.set_policy_version(policy_version),
            Some(_) => {}
        }
        if !self.state.can_issue_grant() {
            return Err(AuthorityStoreFault::RecordTooLarge);
        }

        let expires_at = unix_seconds(expires_at)?;
        let grant_id = random_identifier()?;
        let proof = random_identifier()?;
        let authorization = EnvironmentAuthorization::try_new(
            &grant_id,
            &proof,
            SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(expires_at),
        )
        .map_err(|_| AuthorityStoreFault::RandomUnavailable)?;
        self.state.add_grant(GrantRecord {
            grant_id,
            proof_digest: proof_digest(&proof),
            principal: principal.as_str().to_owned(),
            provenance: provenance.as_str().to_owned(),
            command_digest: command_digest(command),
            expires_at,
            policy_version: policy_version.get(),
            revoked: false,
            redeemed_nonces: Vec::new(),
        });
        super::store::commit_state(&self.path, &self.state)?;
        Ok(EnvironmentGrant { authorization })
    }

    pub fn revoke(&mut self, grant_id: &str) -> Result<(), AuthorityStoreFault> {
        let _lock = super::store::lock(&self.path)?;
        self.state = refresh_state(&self.path)?;
        let grant = self
            .state
            .grant_mut(grant_id)
            .ok_or(AuthorityStoreFault::UnknownGrant)?;
        grant.revoked = true;
        super::store::commit_state(&self.path, &self.state)
    }

    pub fn set_policy_version(
        &mut self,
        policy_version: PolicyVersion,
    ) -> Result<(), AuthorityStoreFault> {
        let _lock = super::store::lock(&self.path)?;
        self.state = refresh_state(&self.path)?;
        if self
            .state
            .policy_version()?
            .is_some_and(|current| current.get() >= policy_version.get())
        {
            return Err(AuthorityStoreFault::PolicyVersionConflict);
        }
        self.state.set_policy_version(policy_version);
        super::store::commit_state(&self.path, &self.state)
    }

    pub fn authorize(
        &mut self,
        principal: &EnvironmentPrincipal,
        authorization: &EnvironmentAuthorization,
        provenance: &EnvironmentProvenance,
        nonce: &EnvironmentNonce,
        command: &EnvironmentCommand,
        now: SystemTime,
    ) -> Result<(), EnvironmentAuthorizationRejection<AuthorityStoreFault>> {
        let _lock = super::store::lock(&self.path)
            .map_err(EnvironmentAuthorizationRejection::Unavailable)?;
        self.state =
            refresh_state(&self.path).map_err(EnvironmentAuthorizationRejection::Unavailable)?;
        let now = unix_seconds(now).map_err(EnvironmentAuthorizationRejection::Unavailable)?;
        let current_policy = self
            .state
            .policy_version()
            .map_err(EnvironmentAuthorizationRejection::Unavailable)?;
        let nonce_digest = nonce_digest(authorization.grant_id(), nonce);
        let grant = self
            .state
            .grant(authorization.grant_id())
            .ok_or(EnvironmentAuthorizationRejection::Denied)?;
        let grant_policy = PolicyVersion::try_new(grant.policy_version).map_err(|_| {
            EnvironmentAuthorizationRejection::Unavailable(AuthorityStoreFault::InvalidRecord)
        })?;

        if grant.revoked || current_policy != Some(grant_policy) {
            return Err(EnvironmentAuthorizationRejection::Revoked);
        }
        if now >= grant.expires_at {
            return Err(EnvironmentAuthorizationRejection::Expired);
        }
        if grant.principal != principal.as_str()
            || grant.provenance != provenance.as_str()
            || grant.command_digest != command_digest(command)
            || !constant_time_matches(&grant.proof_digest, &proof_digest(authorization.proof()))
        {
            return Err(EnvironmentAuthorizationRejection::Denied);
        }
        if grant
            .redeemed_nonces
            .iter()
            .any(|redeemed| redeemed == &nonce_digest)
        {
            return Err(EnvironmentAuthorizationRejection::Replay);
        }
        if grant.redeemed_nonces.len() >= MAX_REDEEMED_NONCES {
            return Err(EnvironmentAuthorizationRejection::Unavailable(
                AuthorityStoreFault::RecordTooLarge,
            ));
        }
        self.state
            .grant_mut(authorization.grant_id())
            .expect("a grant found in the refreshed state remains addressable")
            .redeemed_nonces
            .push(nonce_digest);
        super::store::commit_state(&self.path, &self.state)
            .map_err(EnvironmentAuthorizationRejection::Unavailable)
    }
}

impl EnvironmentAuthorizationPort for EnvironmentAuthorizationAuthority {
    type Error = AuthorityStoreFault;

    fn authorize(
        &mut self,
        principal: &EnvironmentPrincipal,
        authorization: &EnvironmentAuthorization,
        provenance: &EnvironmentProvenance,
        nonce: &EnvironmentNonce,
        command: &EnvironmentCommand,
        now: SystemTime,
    ) -> Result<(), EnvironmentAuthorizationRejection<Self::Error>> {
        self.authorize(principal, authorization, provenance, nonce, command, now)
    }
}

fn random_identifier() -> Result<String, AuthorityStoreFault> {
    let mut bytes = [0_u8; RANDOM_BYTES];
    fill(&mut bytes).map_err(|_| AuthorityStoreFault::RandomUnavailable)?;
    Ok(hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[usize::from(byte >> 4)] as char);
        value.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    value
}
