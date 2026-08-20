use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{AuthorityStoreFault, PolicyVersion};
use crate::{
    BrowserMode, ChannelDirectMessagePolicy, EnvironmentCommand, EnvironmentNonce, SecurityPreset,
};

const SCHEMA_VERSION: u8 = 1;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_GRANTS: usize = 1_024;
const MAX_NONCES_PER_GRANT: usize = 1_024;

#[derive(Deserialize, Serialize)]
pub(super) struct AuthorityState {
    schema_version: u8,
    policy_version: Option<u64>,
    grants: Vec<GrantRecord>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct GrantRecord {
    pub(super) grant_id: String,
    pub(super) proof_digest: String,
    pub(super) principal: String,
    pub(super) provenance: String,
    pub(super) command_digest: String,
    pub(super) expires_at: u64,
    pub(super) policy_version: u64,
    pub(super) revoked: bool,
    pub(super) redeemed_nonces: Vec<String>,
}

impl AuthorityState {
    pub(super) fn initialized() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            policy_version: None,
            grants: Vec::new(),
        }
    }

    pub(super) fn policy_version(&self) -> Result<Option<PolicyVersion>, AuthorityStoreFault> {
        self.policy_version
            .map(PolicyVersion::try_new)
            .transpose()
            .map_err(|_| AuthorityStoreFault::InvalidRecord)
    }

    pub(super) fn set_policy_version(&mut self, version: PolicyVersion) {
        self.policy_version = Some(version.get());
    }

    pub(super) fn grant(&self, grant_id: &str) -> Option<&GrantRecord> {
        self.grants.iter().find(|grant| grant.grant_id == grant_id)
    }

    pub(super) fn grant_mut(&mut self, grant_id: &str) -> Option<&mut GrantRecord> {
        self.grants
            .iter_mut()
            .find(|grant| grant.grant_id == grant_id)
    }

    pub(super) fn can_issue_grant(&self) -> bool {
        self.grants.len() < MAX_GRANTS
    }

    pub(super) fn add_grant(&mut self, grant: GrantRecord) {
        self.grants.push(grant);
    }
}

pub(super) fn open_state(path: &Path) -> Result<AuthorityState, AuthorityStoreFault> {
    ensure_parent_directory(path)?;
    let _lock = WriterLock::acquire(&lock_path(path))?;
    recover_or_initialize(path)
}

pub(super) fn refresh_state(path: &Path) -> Result<AuthorityState, AuthorityStoreFault> {
    recover_or_initialize(path)
}

pub(super) fn commit_state(path: &Path, state: &AuthorityState) -> Result<(), AuthorityStoreFault> {
    let encoded = serde_json::to_vec(state).map_err(|_| AuthorityStoreFault::InvalidRecord)?;
    if encoded.len() > MAX_RECORD_BYTES {
        return Err(AuthorityStoreFault::RecordTooLarge);
    }

    let temporary = temporary_path(path);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| AuthorityStoreFault::Commit(error.kind()))?;
        file.write_all(&encoded)
            .map_err(|error| AuthorityStoreFault::Commit(error.kind()))?;
        file.sync_all()
            .map_err(|error| AuthorityStoreFault::Commit(error.kind()))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| AuthorityStoreFault::Commit(error.kind()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn lock(path: &Path) -> Result<WriterLock, AuthorityStoreFault> {
    WriterLock::acquire(&lock_path(path))
}

pub(super) fn proof_digest(proof: &str) -> String {
    digest([proof.as_bytes()])
}

pub(super) fn nonce_digest(grant_id: &str, nonce: &EnvironmentNonce) -> String {
    digest([grant_id.as_bytes(), &[0], nonce.as_str().as_bytes()])
}

pub(super) fn command_digest(command: &EnvironmentCommand) -> String {
    let mut digest = Sha256::new();
    match command {
        EnvironmentCommand::Create(create) => {
            digest.update([1]);
            hash_definition(&mut digest, create.definition());
        }
        EnvironmentCommand::Replace(replace) => {
            digest.update([2]);
            hash_string(&mut digest, replace.environment_id().as_str());
            hash_u64(&mut digest, replace.expected_revision().get());
            hash_definition(&mut digest, replace.definition());
        }
        EnvironmentCommand::Delete(delete) => {
            digest.update([3]);
            hash_string(&mut digest, delete.environment_id().as_str());
            hash_u64(&mut digest, delete.expected_revision().get());
        }
    }
    hex(&digest.finalize())
}

pub(super) fn unix_seconds(time: SystemTime) -> Result<u64, AuthorityStoreFault> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AuthorityStoreFault::InvalidRecord)
}

pub(super) fn constant_time_matches(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn recover_or_initialize(path: &Path) -> Result<AuthorityState, AuthorityStoreFault> {
    clear_stale_temporary(path)?;
    match File::open(path) {
        Ok(mut file) => {
            let mut encoded = Vec::new();
            file.read_to_end(&mut encoded)
                .map_err(|error| AuthorityStoreFault::Read(error.kind()))?;
            if encoded.len() > MAX_RECORD_BYTES {
                return Err(AuthorityStoreFault::RecordTooLarge);
            }
            let state = serde_json::from_slice::<AuthorityState>(&encoded)
                .map_err(|_| AuthorityStoreFault::InvalidRecord)?;
            validate_state(state)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let state = AuthorityState::initialized();
            commit_state(path, &state)?;
            Ok(state)
        }
        Err(error) => Err(AuthorityStoreFault::Read(error.kind())),
    }
}

fn clear_stale_temporary(path: &Path) -> Result<(), AuthorityStoreFault> {
    match fs::remove_file(temporary_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AuthorityStoreFault::Read(error.kind())),
    }
}

fn validate_state(state: AuthorityState) -> Result<AuthorityState, AuthorityStoreFault> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(AuthorityStoreFault::UnsupportedSchema);
    }
    if state.grants.len() > MAX_GRANTS {
        return Err(AuthorityStoreFault::RecordTooLarge);
    }
    if state.policy_version.is_some_and(|version| version == 0) {
        return Err(AuthorityStoreFault::InvalidRecord);
    }
    if state.grants.iter().any(|grant| {
        grant.grant_id.is_empty()
            || grant.proof_digest.len() != 64
            || grant.command_digest.len() != 64
            || grant.principal.is_empty()
            || grant.provenance.is_empty()
            || grant.policy_version == 0
            || grant.redeemed_nonces.len() > MAX_NONCES_PER_GRANT
            || grant.redeemed_nonces.iter().any(|nonce| nonce.len() != 64)
    }) || state.grants.iter().enumerate().any(|(index, grant)| {
        state.grants[..index]
            .iter()
            .any(|prior| prior.grant_id == grant.grant_id)
    }) {
        return Err(AuthorityStoreFault::InvalidRecord);
    }
    Ok(state)
}

fn ensure_parent_directory(path: &Path) -> Result<(), AuthorityStoreFault> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    fs::create_dir_all(parent).map_err(|error| AuthorityStoreFault::Commit(error.kind()))
}

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}

pub(super) struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, AuthorityStoreFault> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| match error.kind() {
                io::ErrorKind::AlreadyExists => AuthorityStoreFault::WriterBusy,
                kind => AuthorityStoreFault::Lock(kind),
            })?;
        Ok(Self {
            path: path.to_owned(),
        })
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn hash_definition(digest: &mut Sha256, definition: &crate::DesiredDefinition) {
    hash_string(digest, definition.environment_id().as_str());
    hash_u64(digest, definition.revision().get());
    hash_string(digest, definition.provider().as_str());
    hash_references(
        digest,
        definition
            .connectors()
            .iter()
            .map(|reference| reference.as_str()),
    );
    hash_references(
        digest,
        definition
            .extensions()
            .iter()
            .map(|reference| reference.as_str()),
    );
    hash_references(
        digest,
        definition
            .channels()
            .iter()
            .map(|reference| reference.as_str()),
    );
    hash_references(
        digest,
        definition
            .credential_references()
            .iter()
            .map(|reference| reference.as_str()),
    );
    hash_references(
        digest,
        definition
            .policies()
            .iter()
            .map(|reference| reference.as_str()),
    );
    hash_references(
        digest,
        definition
            .toolchains()
            .iter()
            .map(|reference| reference.as_str()),
    );
    digest.update([security_preset(definition.security_preset())]);
    digest.update([browser_mode(definition.browser_mode())]);
    hash_u64(
        digest,
        u64::try_from(definition.operational_channels().len()).expect("slice length fits in u64"),
    );
    for channel in definition.operational_channels() {
        hash_string(digest, channel.channel().as_str());
        hash_string(digest, channel.account().as_str());
        digest.update([u8::from(channel.enabled())]);
        digest.update([direct_message_policy(channel.direct_message_policy())]);
    }
}

fn hash_references<'a>(digest: &mut Sha256, references: impl Iterator<Item = &'a str>) {
    let references = references.collect::<Vec<_>>();
    hash_u64(
        digest,
        u64::try_from(references.len()).expect("reference count fits in u64"),
    );
    for reference in references {
        hash_string(digest, reference);
    }
}

fn hash_string(digest: &mut Sha256, value: &str) {
    hash_u64(
        digest,
        u64::try_from(value.len()).expect("string length fits in u64"),
    );
    digest.update(value.as_bytes());
}

fn hash_u64(digest: &mut Sha256, value: u64) {
    digest.update(value.to_be_bytes());
}

fn security_preset(value: SecurityPreset) -> u8 {
    match value {
        SecurityPreset::Strict => 1,
        SecurityPreset::Balanced => 2,
        SecurityPreset::Relaxed => 3,
    }
}

fn browser_mode(value: BrowserMode) -> u8 {
    match value {
        BrowserMode::Native => 1,
        BrowserMode::Relay => 2,
        BrowserMode::Off => 3,
    }
}

fn direct_message_policy(value: ChannelDirectMessagePolicy) -> u8 {
    match value {
        ChannelDirectMessagePolicy::Pairing => 1,
        ChannelDirectMessagePolicy::Allowlist => 2,
        ChannelDirectMessagePolicy::Open => 3,
        ChannelDirectMessagePolicy::Disabled => 4,
    }
}

fn digest<const N: usize>(parts: [&[u8]; N]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    hex(&digest.finalize())
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
