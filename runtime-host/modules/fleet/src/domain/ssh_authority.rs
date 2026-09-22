//! Operator-signed, private-source SSH host-key authority.
//!
//! SSH host keys are not target configuration and are never learned from a
//! connection attempt.  This module only accepts a signed authority document
//! from the configured source, binds every pin to `(targetId, targetRevision)`,
//! and fails closed for missing, expired, revoked, or conflicting pins.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer as _, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::TargetId;

const DOCUMENT_VERSION: u8 = 1;
const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Private, operator-controlled authority source configuration.
#[derive(Clone, Eq, PartialEq)]
pub struct SshHostKeyAuthorityInput {
    source_path: PathBuf,
    operator_verification_key: String,
}

impl SshHostKeyAuthorityInput {
    pub fn try_new(
        source_path: impl Into<PathBuf>,
        operator_verification_key: impl Into<String>,
    ) -> Result<Self, SshHostKeyAuthorityError> {
        let source_path = source_path.into();
        if !source_path.is_absolute() {
            return Err(SshHostKeyAuthorityError::InvalidSourcePath);
        }
        let operator_verification_key = operator_verification_key.into();
        if operator_verification_key.trim().is_empty() {
            return Err(SshHostKeyAuthorityError::InvalidOperatorKey);
        }
        Ok(Self {
            source_path,
            operator_verification_key,
        })
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    /// Base64url-encoded raw Ed25519 public key or SubjectPublicKeyInfo.
    pub fn operator_verification_key(&self) -> &str {
        &self.operator_verification_key
    }
}

impl fmt::Debug for SshHostKeyAuthorityInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshHostKeyAuthorityInput")
            .field("source_path", &self.source_path)
            .field("operator_verification_key", &"<redacted>")
            .finish()
    }
}

/// A signed SSH host-key authority record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostKeyAuthorityRecord {
    target_id: String,
    target_revision: u64,
    host_key: String,
    issued_at: u64,
    expires_at: u64,
    rotation: u64,
    state: SshHostKeyAuthorityState,
}

impl SshHostKeyAuthorityRecord {
    pub fn try_new(
        target_id: TargetId,
        target_revision: u64,
        host_key: impl Into<String>,
        issued_at: SystemTime,
        expires_at: SystemTime,
        rotation: u64,
        state: SshHostKeyAuthorityState,
    ) -> Result<Self, SshHostKeyAuthorityError> {
        let issued_at = unix_seconds(issued_at)?;
        let expires_at = unix_seconds(expires_at)?;
        let host_key = host_key.into();
        validate_record_fields(
            target_id.as_str(),
            target_revision,
            &host_key,
            issued_at,
            expires_at,
            rotation,
        )?;
        Ok(Self {
            target_id: target_id.as_str().to_owned(),
            target_revision,
            host_key,
            issued_at,
            expires_at,
            rotation,
            state,
        })
    }

    pub fn target_id(&self) -> Result<TargetId, SshHostKeyAuthorityError> {
        TargetId::try_new(self.target_id.clone())
            .map_err(|_| SshHostKeyAuthorityError::InvalidRecord)
    }

    pub fn target_revision(&self) -> u64 {
        self.target_revision
    }

    /// OpenSSH public-key text. It is parsed by the native SSH provider only
    /// after this signed record has been selected.
    pub fn host_key(&self) -> &str {
        &self.host_key
    }

    pub fn issued_at(&self) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(self.issued_at)
    }

    pub fn expires_at(&self) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(self.expires_at)
    }

    pub fn rotation(&self) -> u64 {
        self.rotation
    }

    pub fn state(&self) -> SshHostKeyAuthorityState {
        self.state
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshHostKeyAuthorityState {
    Active,
    Revoked,
}

/// Source document. The signature covers the canonical JSON encoding of all
/// fields except `signature`, in declaration order.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostKeyAuthorityDocument {
    version: u8,
    source_revision: u64,
    pins: Vec<SshHostKeyAuthorityRecord>,
    signature: String,
}

impl SshHostKeyAuthorityDocument {
    pub fn new_signed(
        source_revision: u64,
        pins: Vec<SshHostKeyAuthorityRecord>,
        signing_key: &ed25519_dalek::SigningKey,
    ) -> Result<Self, SshHostKeyAuthorityError> {
        if source_revision == 0 {
            return Err(SshHostKeyAuthorityError::InvalidSourceRevision);
        }
        validate_records(&pins)?;
        let payload = unsigned_payload(source_revision, &pins)?;
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&payload).to_bytes());
        Ok(Self {
            version: DOCUMENT_VERSION,
            source_revision,
            pins,
            signature,
        })
    }

    pub fn source_revision(&self) -> u64 {
        self.source_revision
    }

    pub fn pins(&self) -> &[SshHostKeyAuthorityRecord] {
        &self.pins
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }

    /// Bytes signed by the operator. This is public so an external authority
    /// producer can produce the exact source format without ad-hoc canonicalization.
    pub fn signing_bytes(
        source_revision: u64,
        pins: &[SshHostKeyAuthorityRecord],
    ) -> Result<Vec<u8>, SshHostKeyAuthorityError> {
        unsigned_payload(source_revision, pins)
    }
}

/// Loaded authority. The source revision is retained to reject rollback or
/// same-revision replacement after a successful load.
#[derive(Clone, Debug)]
pub struct SshHostKeyAuthority {
    source_path: PathBuf,
    operator_key: VerifyingKey,
    source_revision: u64,
    source_digest: [u8; 32],
    pins: BTreeMap<(TargetId, u64), Vec<SshHostKeyAuthorityRecord>>,
}

impl SshHostKeyAuthority {
    pub fn open(input: SshHostKeyAuthorityInput) -> Result<Self, SshHostKeyAuthorityError> {
        let operator_key = decode_verifying_key(input.operator_verification_key())?;
        let document = read_document(input.source_path())?;
        let (source_revision, source_digest, pins) = verify_document(&document, &operator_key)?;
        Ok(Self {
            source_path: input.source_path().to_owned(),
            operator_key,
            source_revision,
            source_digest,
            pins,
        })
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    pub fn source_revision(&self) -> u64 {
        self.source_revision
    }

    /// Reload only accepts a strictly newer source revision. A same-revision
    /// replacement is a conflict; rollback is rejected.
    pub fn reload(&mut self) -> Result<(), SshHostKeyAuthorityError> {
        let document = read_document(&self.source_path)?;
        let (source_revision, source_digest, pins) =
            verify_document(&document, &self.operator_key)?;
        if source_revision < self.source_revision {
            return Err(SshHostKeyAuthorityError::SourceRevisionRollback);
        }
        if source_revision == self.source_revision {
            if source_digest != self.source_digest {
                return Err(SshHostKeyAuthorityError::SourceRevisionConflict);
            }
            return Ok(());
        }
        self.source_revision = source_revision;
        self.source_digest = source_digest;
        self.pins = pins;
        Ok(())
    }

    pub fn resolve(
        &self,
        target_id: &TargetId,
        target_revision: u64,
        now: SystemTime,
    ) -> Result<SshHostKeyAuthorityRecord, SshHostKeyAuthorityError> {
        if target_revision == 0 {
            return Err(SshHostKeyAuthorityError::InvalidTargetRevision);
        }
        let records = self
            .pins
            .get(&(target_id.clone(), target_revision))
            .ok_or(SshHostKeyAuthorityError::Missing)?;
        let mut active = records
            .iter()
            .filter(|record| record.state == SshHostKeyAuthorityState::Active);
        let selected = active.next();
        if active.next().is_some() {
            return Err(SshHostKeyAuthorityError::Conflict);
        }
        let revoked = records
            .iter()
            .filter(|record| record.state == SshHostKeyAuthorityState::Revoked)
            .collect::<Vec<_>>();
        if let Some(selected) = selected {
            if revoked.iter().any(|record| {
                record.host_key == selected.host_key || record.rotation > selected.rotation
            }) {
                return Err(SshHostKeyAuthorityError::Conflict);
            }
            let now = unix_seconds(now)?;
            if now < selected.issued_at {
                return Err(SshHostKeyAuthorityError::NotYetValid);
            }
            if now >= selected.expires_at {
                return Err(SshHostKeyAuthorityError::Expired);
            }
            return Ok(selected.clone());
        }
        if !revoked.is_empty() {
            return Err(SshHostKeyAuthorityError::Revoked);
        }
        Err(SshHostKeyAuthorityError::Missing)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SshHostKeyAuthorityError {
    InvalidSourcePath,
    InvalidOperatorKey,
    SourceUnavailable,
    SourceTooLarge,
    InvalidDocument,
    InvalidSignature,
    InvalidSourceRevision,
    SourceRevisionRollback,
    SourceRevisionConflict,
    InvalidRecord,
    InvalidTargetRevision,
    InvalidTime,
    Missing,
    Expired,
    NotYetValid,
    Revoked,
    Conflict,
}

impl fmt::Display for SshHostKeyAuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSourcePath => "SSH host-key authority source path is invalid",
            Self::InvalidOperatorKey => "SSH host-key authority operator key is invalid",
            Self::SourceUnavailable => "SSH host-key authority source is unavailable",
            Self::SourceTooLarge => "SSH host-key authority source is too large",
            Self::InvalidDocument => "SSH host-key authority document is invalid",
            Self::InvalidSignature => "SSH host-key authority signature is invalid",
            Self::InvalidSourceRevision => "SSH host-key authority source revision is invalid",
            Self::SourceRevisionRollback => "SSH host-key authority source revision rolled back",
            Self::SourceRevisionConflict => "SSH host-key authority source revision conflicts",
            Self::InvalidRecord => "SSH host-key authority record is invalid",
            Self::InvalidTargetRevision => "SSH host-key authority target revision is invalid",
            Self::InvalidTime => "SSH host-key authority timestamp is invalid",
            Self::Missing => "SSH host-key authority pin is missing",
            Self::Expired => "SSH host-key authority pin is expired",
            Self::NotYetValid => "SSH host-key authority pin is not yet valid",
            Self::Revoked => "SSH host-key authority pin is revoked",
            Self::Conflict => "SSH host-key authority pin is conflicting",
        })
    }
}

impl std::error::Error for SshHostKeyAuthorityError {}

fn read_document(path: &Path) -> Result<SshHostKeyAuthorityDocument, SshHostKeyAuthorityError> {
    let metadata = fs::metadata(path).map_err(|_| SshHostKeyAuthorityError::SourceUnavailable)?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(SshHostKeyAuthorityError::SourceTooLarge);
    }
    let bytes = fs::read(path).map_err(|_| SshHostKeyAuthorityError::SourceUnavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| SshHostKeyAuthorityError::InvalidDocument)
}

fn verify_document(
    document: &SshHostKeyAuthorityDocument,
    operator_key: &VerifyingKey,
) -> Result<
    (
        u64,
        [u8; 32],
        BTreeMap<(TargetId, u64), Vec<SshHostKeyAuthorityRecord>>,
    ),
    SshHostKeyAuthorityError,
> {
    if document.version != DOCUMENT_VERSION || document.source_revision == 0 {
        return Err(SshHostKeyAuthorityError::InvalidDocument);
    }
    validate_records(&document.pins)?;
    let payload = unsigned_payload(document.source_revision, &document.pins)?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(document.signature.as_bytes())
        .map_err(|_| SshHostKeyAuthorityError::InvalidSignature)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| SshHostKeyAuthorityError::InvalidSignature)?;
    operator_key
        .verify(&payload, &signature)
        .map_err(|_| SshHostKeyAuthorityError::InvalidSignature)?;
    let digest = sha256(
        &serde_json::to_vec(document).map_err(|_| SshHostKeyAuthorityError::InvalidDocument)?,
    );
    let mut pins = BTreeMap::new();
    for record in document.pins.iter().cloned() {
        let target_id = record.target_id()?;
        let entries = pins
            .entry((target_id, record.target_revision))
            .or_insert_with(Vec::new);
        if record.state == SshHostKeyAuthorityState::Active
            && entries.iter().any(|current: &SshHostKeyAuthorityRecord| {
                current.state == SshHostKeyAuthorityState::Active
            })
        {
            return Err(SshHostKeyAuthorityError::Conflict);
        }
        entries.push(record);
    }
    Ok((document.source_revision, digest, pins))
}

fn validate_records(records: &[SshHostKeyAuthorityRecord]) -> Result<(), SshHostKeyAuthorityError> {
    if records.is_empty() {
        return Err(SshHostKeyAuthorityError::InvalidDocument);
    }
    let mut identities = BTreeSet::new();
    for record in records {
        validate_record_fields(
            &record.target_id,
            record.target_revision,
            &record.host_key,
            record.issued_at,
            record.expires_at,
            record.rotation,
        )?;
        TargetId::try_new(record.target_id.clone())
            .map_err(|_| SshHostKeyAuthorityError::InvalidRecord)?;
        if !identities.insert((
            record.target_id.clone(),
            record.target_revision,
            record.rotation,
        )) {
            return Err(SshHostKeyAuthorityError::Conflict);
        }
    }
    Ok(())
}

fn validate_record_fields(
    target_id: &str,
    target_revision: u64,
    host_key: &str,
    issued_at: u64,
    expires_at: u64,
    rotation: u64,
) -> Result<(), SshHostKeyAuthorityError> {
    if TargetId::try_new(target_id.to_owned()).is_err()
        || target_revision == 0
        || rotation == 0
        || issued_at >= expires_at
        || host_key.len() > 16 * 1024
        || host_key.trim() != host_key
        || host_key.contains('\0')
    {
        return Err(SshHostKeyAuthorityError::InvalidRecord);
    }

    let parsed = russh::keys::PublicKey::from_openssh(host_key)
        .map_err(|_| SshHostKeyAuthorityError::InvalidRecord)?;
    if parsed
        .to_openssh()
        .map_err(|_| SshHostKeyAuthorityError::InvalidRecord)?
        != host_key
    {
        return Err(SshHostKeyAuthorityError::InvalidRecord);
    }
    Ok(())
}

fn unsigned_payload(
    source_revision: u64,
    pins: &[SshHostKeyAuthorityRecord],
) -> Result<Vec<u8>, SshHostKeyAuthorityError> {
    if source_revision == 0 {
        return Err(SshHostKeyAuthorityError::InvalidSourceRevision);
    }
    serde_json::to_vec(&UnsignedDocument {
        version: DOCUMENT_VERSION,
        source_revision,
        pins,
    })
    .map_err(|_| SshHostKeyAuthorityError::InvalidDocument)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedDocument<'a> {
    version: u8,
    source_revision: u64,
    pins: &'a [SshHostKeyAuthorityRecord],
}

fn decode_verifying_key(value: &str) -> Result<VerifyingKey, SshHostKeyAuthorityError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.trim().as_bytes())
        .map_err(|_| SshHostKeyAuthorityError::InvalidOperatorKey)?;
    let raw = decoded
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .unwrap_or(decoded.as_slice());
    let raw: [u8; 32] = raw
        .try_into()
        .map_err(|_| SshHostKeyAuthorityError::InvalidOperatorKey)?;
    VerifyingKey::from_bytes(&raw).map_err(|_| SshHostKeyAuthorityError::InvalidOperatorKey)
}

fn unix_seconds(value: SystemTime) -> Result<u64, SshHostKeyAuthorityError> {
    value
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SshHostKeyAuthorityError::InvalidTime)
        .map(|duration| duration.as_secs())
}

fn sha256(value: &[u8]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    Sha256::digest(value).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    static NEXT_PATH: AtomicU64 = AtomicU64::new(1);

    fn source_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "matcha-fleet-ssh-authority-{}-{}.json",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn record(
        target: &str,
        revision: u64,
        rotation: u64,
        state: SshHostKeyAuthorityState,
    ) -> SshHostKeyAuthorityRecord {
        let now = UNIX_EPOCH + Duration::from_secs(100);
        SshHostKeyAuthorityRecord::try_new(
            TargetId::try_new(target).unwrap(),
            revision,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            now,
            now + Duration::from_secs(100),
            rotation,
            state,
        )
        .unwrap()
    }

    fn write_document(
        path: &Path,
        revision: u64,
        pins: Vec<SshHostKeyAuthorityRecord>,
        key: &ed25519_dalek::SigningKey,
    ) -> SshHostKeyAuthorityInput {
        let document = SshHostKeyAuthorityDocument::new_signed(revision, pins, key).unwrap();
        fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
        SshHostKeyAuthorityInput::try_new(
            path,
            URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn empty_signed_source_is_rejected() {
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[6; 32]);
        assert_eq!(
            SshHostKeyAuthorityDocument::new_signed(1, Vec::new(), &signing_key).unwrap_err(),
            SshHostKeyAuthorityError::InvalidDocument
        );
    }

    #[test]
    fn malformed_host_key_is_rejected_by_russh_parser() {
        let now = UNIX_EPOCH + Duration::from_secs(100);
        assert_eq!(
            SshHostKeyAuthorityRecord::try_new(
                TargetId::try_new("target-a").unwrap(),
                1,
                "ssh-ed25519 not-a-key",
                now,
                now + Duration::from_secs(100),
                1,
                SshHostKeyAuthorityState::Active,
            )
            .unwrap_err(),
            SshHostKeyAuthorityError::InvalidRecord
        );
    }

    #[test]
    fn signed_source_resolves_target_revision_and_survives_reopen() {
        let path = source_path();
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let input = write_document(
            &path,
            1,
            vec![record("target-a", 3, 1, SshHostKeyAuthorityState::Active)],
            &signing_key,
        );
        let authority = SshHostKeyAuthority::open(input.clone()).unwrap();
        let resolved = authority
            .resolve(
                &TargetId::try_new("target-a").unwrap(),
                3,
                UNIX_EPOCH + Duration::from_secs(150),
            )
            .unwrap();
        assert_eq!(resolved.rotation(), 1);
        assert_eq!(
            SshHostKeyAuthority::open(input).unwrap().source_revision(),
            1
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_expired_revoked_and_conflicting_pins_fail_closed() {
        let path = source_path();
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
        let revoked = record("target-a", 1, 1, SshHostKeyAuthorityState::Revoked);
        let input = write_document(&path, 1, vec![revoked], &signing_key);
        let authority = SshHostKeyAuthority::open(input).unwrap();
        let target = TargetId::try_new("target-a").unwrap();
        assert_eq!(
            authority
                .resolve(&target, 1, UNIX_EPOCH + Duration::from_secs(150))
                .unwrap_err(),
            SshHostKeyAuthorityError::Revoked
        );
        assert_eq!(
            authority
                .resolve(&target, 2, UNIX_EPOCH + Duration::from_secs(150))
                .unwrap_err(),
            SshHostKeyAuthorityError::Missing
        );
        let _ = fs::remove_file(path);

        let path = source_path();
        let first = record("target-a", 1, 1, SshHostKeyAuthorityState::Active);
        let second = record("target-a", 1, 2, SshHostKeyAuthorityState::Active);
        let input = write_document(&path, 1, vec![first, second], &signing_key);
        assert_eq!(
            SshHostKeyAuthority::open(input).unwrap_err(),
            SshHostKeyAuthorityError::Conflict
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rotation_accepts_old_revocation_and_new_active_pin() {
        let path = source_path();
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let old = record("target-a", 1, 1, SshHostKeyAuthorityState::Revoked);
        let mut new = record("target-a", 1, 2, SshHostKeyAuthorityState::Active);
        new.host_key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                .into();
        let input = write_document(&path, 1, vec![old, new], &signing_key);
        let authority = SshHostKeyAuthority::open(input).unwrap();
        assert_eq!(
            authority
                .resolve(
                    &TargetId::try_new("target-a").unwrap(),
                    1,
                    UNIX_EPOCH + Duration::from_secs(150)
                )
                .unwrap()
                .rotation(),
            2
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reload_rejects_same_revision_replacement_and_rollback() {
        let path = source_path();
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[10; 32]);
        let input = write_document(
            &path,
            2,
            vec![record("target-a", 1, 1, SshHostKeyAuthorityState::Active)],
            &signing_key,
        );
        let mut authority = SshHostKeyAuthority::open(input).unwrap();
        write_document(
            &path,
            1,
            vec![record("target-a", 1, 1, SshHostKeyAuthorityState::Active)],
            &signing_key,
        );
        assert_eq!(
            authority.reload().unwrap_err(),
            SshHostKeyAuthorityError::SourceRevisionRollback
        );
        write_document(
            &path,
            2,
            vec![record("target-a", 1, 1, SshHostKeyAuthorityState::Revoked)],
            &signing_key,
        );
        assert_eq!(
            authority.reload().unwrap_err(),
            SshHostKeyAuthorityError::SourceRevisionConflict
        );
        let _ = fs::remove_file(path);
    }
}
