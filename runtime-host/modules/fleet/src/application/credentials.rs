//! Private Fleet credential producer.
//!
//! This module owns the Host-side private projection of Fleet credentials.  It
//! accepts only `remote-fleet://credentials/<id>/<name>` references, keeps the
//! credential value in a zeroizing type, and persists only authenticated
//! ciphertext and operation receipts.  Composition should inject the port
//! traits below rather than depend on the file layout or encryption format.

use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate as fleet;
use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, generic_array::GenericArray},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use fleet::{FleetSecretRef, FleetSecretResolution, FleetSecretResolverPort};
use getrandom::fill as random_fill;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

const STATE_VERSION: u8 = 1;
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_CREDENTIAL_ID_BYTES: usize = 128;
const MAX_CREDENTIAL_VALUE_BYTES: usize = 256 * 1024;
const MAX_TIMESTAMP_BYTES: usize = 64;
const CREDENTIAL_DIRECTORY: &str = "remote-fleet";
const STATE_FILE: &str = "credentials.json";
const KEY_FILE: &str = "credential-key";
const SECRET_REF_PREFIX: &str = "remote-fleet://credentials/";

/// The only credential names currently produced by Fleet Host RPC.
#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
pub enum FleetCredentialName {
    SshPassword,
    SshPrivateKey,
    DockerBearerToken,
    KubeBearerToken,
}

impl FleetCredentialName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SshPassword => "sshPassword",
            Self::SshPrivateKey => "sshPrivateKey",
            Self::DockerBearerToken => "dockerBearerToken",
            Self::KubeBearerToken => "kubeBearerToken",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "sshPassword" => Some(Self::SshPassword),
            "sshPrivateKey" => Some(Self::SshPrivateKey),
            "dockerBearerToken" => Some(Self::DockerBearerToken),
            "kubeBearerToken" => Some(Self::KubeBearerToken),
            _ => None,
        }
    }
}

impl fmt::Debug for FleetCredentialName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for FleetCredentialName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Secret bytes are deliberately not serializable or inspectable through Debug.
#[derive(Eq, PartialEq)]
pub struct FleetCredentialPlaintext(Vec<u8>);

impl FleetCredentialPlaintext {
    pub fn new(value: String) -> Result<Self, FleetCredentialVaultError> {
        if value.trim().is_empty() || value.len() > MAX_CREDENTIAL_VALUE_BYTES {
            return Err(FleetCredentialVaultError::InvalidInput);
        }
        Ok(Self(value.into_bytes()))
    }

    fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("Fleet credential plaintext is valid UTF-8")
    }
}

impl AsRef<str> for FleetCredentialPlaintext {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Debug for FleetCredentialPlaintext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FleetCredentialPlaintext(<redacted>)")
    }
}

impl Drop for FleetCredentialPlaintext {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// A typed write request.  It intentionally has no Serialize or Debug impl.
pub struct FleetCredentialWriteRequest {
    pub(crate) operation_id: String,
    pub(crate) credential_id: String,
    pub(crate) credential_name: FleetCredentialName,
    pub(crate) plaintext: FleetCredentialPlaintext,
    pub(crate) written_at: String,
}

/// A receipt is safe to persist and project: it contains no credential value.
#[derive(Clone, Eq, PartialEq)]
pub struct FleetCredentialWriteReceipt {
    pub(crate) operation_id: String,
    pub(crate) credential_name: FleetCredentialName,
    pub(crate) credential_ref: FleetSecretRef,
    pub(crate) written_at: String,
}

impl fmt::Debug for FleetCredentialWriteReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FleetCredentialWriteReceipt")
            .field("operation_id", &self.operation_id)
            .field("credential_name", &self.credential_name)
            .field("credential_ref", &self.credential_ref)
            .field("written_at", &self.written_at)
            .finish()
    }
}

pub enum FleetCredentialWriteOutcome {
    Written(FleetCredentialWriteReceipt),
    OperationConflict,
}

pub(crate) struct FleetCredentialReceiptLookup<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) credential_name: FleetCredentialName,
    pub(crate) credential_ref: &'a FleetSecretRef,
}

pub(crate) enum FleetCredentialReceiptOutcome {
    Completed(FleetCredentialWriteReceipt),
    NotFound,
    OperationConflict,
}

/// The resolver result keeps plaintext scoped to the private owner boundary.
pub(crate) enum FleetCredentialResolveOutcome {
    Resolved(FleetCredentialPlaintext),
    NotFound,
    AccessDenied,
}

pub(crate) trait FleetCredentialWriterPort {
    fn write_credential(
        &self,
        request: FleetCredentialWriteRequest,
    ) -> Result<FleetCredentialWriteOutcome, FleetCredentialVaultError>;

    fn lookup_write_receipt(
        &self,
        request: FleetCredentialReceiptLookup<'_>,
    ) -> Result<FleetCredentialReceiptOutcome, FleetCredentialVaultError>;
}

pub(crate) trait FleetCredentialResolverPort {
    fn resolve_credential(
        &self,
        secret_ref: &FleetSecretRef,
    ) -> Result<FleetCredentialResolveOutcome, FleetCredentialVaultError>;
}

/// A private, file-backed Fleet credential owner.
///
/// `private_root` must be the already-authorized Host private storage root.  The
/// vault creates only its own `remote-fleet` child and never writes to public
/// runtime state.
pub(crate) struct FleetCredentialVault {
    directory: PathBuf,
    state_path: PathBuf,
    key_path: PathBuf,
    operation_lock: Mutex<()>,
}

impl FleetCredentialVault {
    pub(crate) fn open(private_root: impl AsRef<Path>) -> Result<Self, FleetCredentialVaultError> {
        let private_root = private_root.as_ref();
        if !private_root.is_absolute() {
            return Err(FleetCredentialVaultError::InvalidInput);
        }
        let directory = private_root.join(CREDENTIAL_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|_| FleetCredentialVaultError::Storage)?;
        set_private_mode(&directory, true)?;
        Ok(Self {
            state_path: directory.join(STATE_FILE),
            key_path: directory.join(KEY_FILE),
            directory,
            operation_lock: Mutex::new(()),
        })
    }

    pub(crate) fn write_credential(
        &self,
        request: FleetCredentialWriteRequest,
    ) -> Result<FleetCredentialWriteOutcome, FleetCredentialVaultError> {
        validate_write_request(&request)?;
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| FleetCredentialVaultError::Storage)?;
        let credential_ref = build_credential_ref(&request.credential_id, request.credential_name)?;
        let mut state = self.read_state()?;
        if let Some(receipt) = state.receipts.get(&request.operation_id) {
            return if receipt_matches(receipt, &request, &credential_ref) {
                Ok(FleetCredentialWriteOutcome::Written(receipt.to_public()?))
            } else {
                Ok(FleetCredentialWriteOutcome::OperationConflict)
            };
        }

        let encrypted = self.encrypt(credential_ref.as_str(), &request.plaintext)?;
        let operation_id = request.operation_id.clone();
        let key = credential_ref.as_str().to_owned();
        let existing_created_at = state
            .credentials
            .get(&key)
            .map(|record| record.created_at.clone())
            .unwrap_or_else(|| request.written_at.clone());
        state.credentials.insert(
            key.clone(),
            EncryptedCredentialRecord {
                version: STATE_VERSION,
                credential_name: request.credential_name.as_str().to_owned(),
                secret_ref: key,
                nonce: encrypted.nonce,
                ciphertext: encrypted.ciphertext,
                created_at: existing_created_at,
                updated_at: request.written_at.clone(),
            },
        );
        state.receipts.insert(
            request.operation_id.clone(),
            PersistedReceipt {
                version: STATE_VERSION,
                operation_id: request.operation_id,
                credential_name: request.credential_name.as_str().to_owned(),
                credential_ref: credential_ref.as_str().to_owned(),
                written_at: request.written_at,
            },
        );
        self.write_state(&state)?;
        let receipt = state
            .receipts
            .get(&operation_id)
            .ok_or(FleetCredentialVaultError::Storage)?;
        Ok(FleetCredentialWriteOutcome::Written(receipt.to_public()?))
    }

    pub(crate) fn lookup_write_receipt(
        &self,
        request: FleetCredentialReceiptLookup<'_>,
    ) -> Result<FleetCredentialReceiptOutcome, FleetCredentialVaultError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| FleetCredentialVaultError::Storage)?;
        let Some(receipt) = self
            .read_state()?
            .receipts
            .get(request.operation_id)
            .cloned()
        else {
            return Ok(FleetCredentialReceiptOutcome::NotFound);
        };
        if receipt.credential_name != request.credential_name.as_str()
            || receipt.credential_ref != request.credential_ref.as_str()
        {
            return Ok(FleetCredentialReceiptOutcome::OperationConflict);
        }
        Ok(FleetCredentialReceiptOutcome::Completed(
            receipt.to_public()?,
        ))
    }

    pub(crate) fn resolve_credential(
        &self,
        secret_ref: &FleetSecretRef,
    ) -> Result<FleetCredentialResolveOutcome, FleetCredentialVaultError> {
        let Some(key) = CredentialKey::from_secret_ref(secret_ref) else {
            return Ok(FleetCredentialResolveOutcome::AccessDenied);
        };
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| FleetCredentialVaultError::Storage)?;
        let state = self.read_state()?;
        let Some(record) = state.credentials.get(secret_ref.as_str()) else {
            return Ok(FleetCredentialResolveOutcome::NotFound);
        };
        if record.credential_name != key.name.as_str() || record.secret_ref != secret_ref.as_str() {
            return Ok(FleetCredentialResolveOutcome::AccessDenied);
        }
        let plaintext = self.decrypt(record)?;
        Ok(FleetCredentialResolveOutcome::Resolved(plaintext))
    }

    fn encrypt(
        &self,
        secret_ref: &str,
        plaintext: &FleetCredentialPlaintext,
    ) -> Result<EncryptedPayload, FleetCredentialVaultError> {
        let key = self.read_or_create_key()?;
        let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
        let mut nonce = [0_u8; NONCE_BYTES];
        random_fill(&mut nonce).map_err(|_| FleetCredentialVaultError::Crypto)?;
        let ciphertext = cipher
            .encrypt(
                GenericArray::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: plaintext.as_bytes(),
                    aad: secret_ref.as_bytes(),
                },
            )
            .map_err(|_| FleetCredentialVaultError::Crypto)?;
        Ok(EncryptedPayload {
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        })
    }

    fn decrypt(
        &self,
        record: &EncryptedCredentialRecord,
    ) -> Result<FleetCredentialPlaintext, FleetCredentialVaultError> {
        let key = self.read_or_create_key()?;
        let nonce = decode_encoded_fixed::<NONCE_BYTES>(&record.nonce)?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(record.ciphertext.as_bytes())
            .map_err(|_| FleetCredentialVaultError::CorruptState)?;
        let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
        let bytes = cipher
            .decrypt(
                GenericArray::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &ciphertext,
                    aad: record.secret_ref.as_bytes(),
                },
            )
            .map_err(|_| FleetCredentialVaultError::Crypto)?;
        let value = String::from_utf8(bytes).map_err(|_| FleetCredentialVaultError::Crypto)?;
        FleetCredentialPlaintext::new(value)
    }

    fn read_or_create_key(&self) -> Result<[u8; KEY_BYTES], FleetCredentialVaultError> {
        match fs::read(&self.key_path) {
            Ok(bytes) => decode_fixed::<KEY_BYTES>(&bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut key = [0_u8; KEY_BYTES];
                random_fill(&mut key).map_err(|_| FleetCredentialVaultError::Crypto)?;
                match OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&self.key_path)
                {
                    Ok(mut file) => {
                        set_private_mode(&self.key_path, false)?;
                        file.write_all(&key)
                            .map_err(|_| FleetCredentialVaultError::Storage)?;
                        file.sync_all()
                            .map_err(|_| FleetCredentialVaultError::Storage)?;
                        Ok(key)
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        decode_fixed::<KEY_BYTES>(
                            &fs::read(&self.key_path)
                                .map_err(|_| FleetCredentialVaultError::Storage)?,
                        )
                    }
                    Err(_) => Err(FleetCredentialVaultError::Storage),
                }
            }
            Err(_) => Err(FleetCredentialVaultError::Storage),
        }
    }

    fn read_state(&self) -> Result<PersistedState, FleetCredentialVaultError> {
        let mut file = match File::open(&self.state_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(PersistedState::empty());
            }
            Err(_) => return Err(FleetCredentialVaultError::Storage),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| FleetCredentialVaultError::Storage)?;
        let state: PersistedState =
            serde_json::from_slice(&bytes).map_err(|_| FleetCredentialVaultError::CorruptState)?;
        state.validate()?;
        Ok(state)
    }

    fn write_state(&self, state: &PersistedState) -> Result<(), FleetCredentialVaultError> {
        let bytes =
            serde_json::to_vec_pretty(state).map_err(|_| FleetCredentialVaultError::Storage)?;
        let mut suffix = [0_u8; 8];
        random_fill(&mut suffix).map_err(|_| FleetCredentialVaultError::Crypto)?;
        let temporary = self.directory.join(format!(
            "credentials.{}.tmp",
            URL_SAFE_NO_PAD.encode(suffix)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| FleetCredentialVaultError::Storage)?;
            set_private_mode(&temporary, false)?;
            file.write_all(&bytes)
                .map_err(|_| FleetCredentialVaultError::Storage)?;
            file.sync_all()
                .map_err(|_| FleetCredentialVaultError::Storage)?;
            fs::rename(&temporary, &self.state_path).map_err(|_| FleetCredentialVaultError::Storage)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

impl FleetCredentialWriterPort for FleetCredentialVault {
    fn write_credential(
        &self,
        request: FleetCredentialWriteRequest,
    ) -> Result<FleetCredentialWriteOutcome, FleetCredentialVaultError> {
        Self::write_credential(self, request)
    }

    fn lookup_write_receipt(
        &self,
        request: FleetCredentialReceiptLookup<'_>,
    ) -> Result<FleetCredentialReceiptOutcome, FleetCredentialVaultError> {
        Self::lookup_write_receipt(self, request)
    }
}

impl FleetCredentialResolverPort for FleetCredentialVault {
    fn resolve_credential(
        &self,
        secret_ref: &FleetSecretRef,
    ) -> Result<FleetCredentialResolveOutcome, FleetCredentialVaultError> {
        Self::resolve_credential(self, secret_ref)
    }
}

impl FleetSecretResolverPort for FleetCredentialVault {
    type Secret = FleetCredentialPlaintext;
    type Error = FleetCredentialVaultError;

    fn resolve(
        &mut self,
        secret_ref: &FleetSecretRef,
    ) -> Result<FleetSecretResolution<Self::Secret>, Self::Error> {
        match self.resolve_credential(secret_ref)? {
            FleetCredentialResolveOutcome::Resolved(secret) => {
                Ok(FleetSecretResolution::Resolved(secret))
            }
            FleetCredentialResolveOutcome::NotFound => Ok(FleetSecretResolution::NotFound),
            FleetCredentialResolveOutcome::AccessDenied => Ok(FleetSecretResolution::AccessDenied),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetCredentialVaultError {
    InvalidInput,
    Storage,
    CorruptState,
    Crypto,
}

impl fmt::Display for FleetCredentialVaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Fleet credential input is invalid",
            Self::Storage => "Fleet credential private storage failed",
            Self::CorruptState => "Fleet credential private storage is corrupt",
            Self::Crypto => "Fleet credential cryptographic operation failed",
        })
    }
}

impl std::error::Error for FleetCredentialVaultError {}

#[derive(Serialize, Deserialize)]
struct PersistedState {
    version: u8,
    credentials: BTreeMap<String, EncryptedCredentialRecord>,
    receipts: BTreeMap<String, PersistedReceipt>,
}

impl PersistedState {
    fn empty() -> Self {
        Self {
            version: STATE_VERSION,
            credentials: BTreeMap::new(),
            receipts: BTreeMap::new(),
        }
    }

    fn validate(&self) -> Result<(), FleetCredentialVaultError> {
        if self.version != STATE_VERSION {
            return Err(FleetCredentialVaultError::CorruptState);
        }
        for (reference, record) in &self.credentials {
            let secret_ref = FleetSecretRef::parse(reference)
                .map_err(|_| FleetCredentialVaultError::CorruptState)?;
            let key = CredentialKey::from_secret_ref(&secret_ref)
                .ok_or(FleetCredentialVaultError::CorruptState)?;
            if record.version != STATE_VERSION
                || record.secret_ref != *reference
                || record.credential_name != key.name.as_str()
                || decode_encoded_fixed::<NONCE_BYTES>(&record.nonce).is_err()
                || URL_SAFE_NO_PAD
                    .decode(record.ciphertext.as_bytes())
                    .is_err()
            {
                return Err(FleetCredentialVaultError::CorruptState);
            }
        }
        for (operation_id, receipt) in &self.receipts {
            let secret_ref = FleetSecretRef::parse(&receipt.credential_ref)
                .map_err(|_| FleetCredentialVaultError::CorruptState)?;
            let key = CredentialKey::from_secret_ref(&secret_ref)
                .ok_or(FleetCredentialVaultError::CorruptState)?;
            if receipt.version != STATE_VERSION
                || !valid_segment(operation_id, MAX_OPERATION_ID_BYTES)
                || receipt.operation_id != *operation_id
                || receipt.credential_name != key.name.as_str()
            {
                return Err(FleetCredentialVaultError::CorruptState);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct EncryptedCredentialRecord {
    version: u8,
    credential_name: String,
    secret_ref: String,
    nonce: String,
    ciphertext: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct PersistedReceipt {
    version: u8,
    operation_id: String,
    credential_name: String,
    credential_ref: String,
    written_at: String,
}

impl PersistedReceipt {
    fn to_public(&self) -> Result<FleetCredentialWriteReceipt, FleetCredentialVaultError> {
        let credential_name = FleetCredentialName::parse(&self.credential_name)
            .ok_or(FleetCredentialVaultError::CorruptState)?;
        let credential_ref = FleetSecretRef::parse(&self.credential_ref)
            .map_err(|_| FleetCredentialVaultError::CorruptState)?;
        if CredentialKey::from_secret_ref(&credential_ref).map(|key| key.name == credential_name)
            != Some(true)
        {
            return Err(FleetCredentialVaultError::CorruptState);
        }
        Ok(FleetCredentialWriteReceipt {
            operation_id: self.operation_id.clone(),
            credential_name,
            credential_ref,
            written_at: self.written_at.clone(),
        })
    }
}

struct EncryptedPayload {
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Copy)]
struct CredentialKey {
    name: FleetCredentialName,
}

impl CredentialKey {
    fn from_secret_ref(secret_ref: &FleetSecretRef) -> Option<Self> {
        let path = secret_ref.as_str().strip_prefix(SECRET_REF_PREFIX)?;
        let mut segments = path.split('/');
        let id = segments.next()?;
        let name = FleetCredentialName::parse(segments.next()?)?;
        if segments.next().is_some() || !valid_segment(id, MAX_CREDENTIAL_ID_BYTES) {
            return None;
        }
        Some(Self { name })
    }
}

fn build_credential_ref(
    credential_id: &str,
    credential_name: FleetCredentialName,
) -> Result<FleetSecretRef, FleetCredentialVaultError> {
    if !valid_segment(credential_id, MAX_CREDENTIAL_ID_BYTES) {
        return Err(FleetCredentialVaultError::InvalidInput);
    }
    FleetSecretRef::parse(&format!(
        "{SECRET_REF_PREFIX}{credential_id}/{}",
        credential_name.as_str()
    ))
    .map_err(|_| FleetCredentialVaultError::InvalidInput)
}

fn validate_write_request(
    request: &FleetCredentialWriteRequest,
) -> Result<(), FleetCredentialVaultError> {
    if !valid_segment(&request.operation_id, MAX_OPERATION_ID_BYTES)
        || !valid_segment(&request.credential_id, MAX_CREDENTIAL_ID_BYTES)
        || request.written_at.is_empty()
        || request.written_at.len() > MAX_TIMESTAMP_BYTES
        || request
            .written_at
            .parse::<chrono::DateTime<chrono::FixedOffset>>()
            .is_err()
    {
        return Err(FleetCredentialVaultError::InvalidInput);
    }
    Ok(())
}

fn receipt_matches(
    receipt: &PersistedReceipt,
    request: &FleetCredentialWriteRequest,
    credential_ref: &FleetSecretRef,
) -> bool {
    receipt.credential_name == request.credential_name.as_str()
        && receipt.credential_ref == credential_ref.as_str()
}

fn decode_fixed<const N: usize>(value: &[u8]) -> Result<[u8; N], FleetCredentialVaultError> {
    if value.len() != N {
        return Err(FleetCredentialVaultError::CorruptState);
    }
    let mut output = [0_u8; N];
    output.copy_from_slice(value);
    Ok(output)
}

fn decode_encoded_fixed<const N: usize>(value: &str) -> Result<[u8; N], FleetCredentialVaultError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| FleetCredentialVaultError::CorruptState)?;
    decode_fixed(&decoded)
}

fn valid_segment(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn set_private_mode(path: &Path, directory: bool) -> Result<(), FleetCredentialVaultError> {
    let mode = if directory {
        foundation::storage::PrivateMode::Directory
    } else {
        foundation::storage::PrivateMode::File
    };
    foundation::storage::set_private_mode(path, mode)
        .map_err(|_| FleetCredentialVaultError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_credentials_references_are_resolvable() {
        let valid = FleetSecretRef::parse("remote-fleet://credentials/node-1/sshPassword").unwrap();
        assert!(CredentialKey::from_secret_ref(&valid).is_some());
        for value in [
            "remote-fleet://node-1/sshPassword",
            "remote-fleet://credentials/node-1/unknown",
            "remote-fleet://credentials/node-1/sshPassword/extra",
        ] {
            let reference = FleetSecretRef::parse(value).unwrap();
            assert!(CredentialKey::from_secret_ref(&reference).is_none());
        }
    }

    #[test]
    fn plaintext_debug_is_redacted() {
        let plaintext = FleetCredentialPlaintext::new("credential-canary".to_owned()).unwrap();
        assert!(!format!("{plaintext:?}").contains("credential-canary"));
    }

    #[test]
    fn rejects_relative_private_root() {
        assert!(matches!(
            FleetCredentialVault::open(PathBuf::from("relative-private-root")),
            Err(FleetCredentialVaultError::InvalidInput)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn vault_private_paths_are_hardened_on_windows() {
        let root = TempRoot::new();
        let private_root = root.path().join("private");
        foundation::storage::provision_private_directory(&private_root).unwrap();
        let vault = FleetCredentialVault::open(&private_root).unwrap();

        set_private_mode(&vault.directory, true).unwrap();
        let request = FleetCredentialWriteRequest {
            operation_id: "op-1".into(),
            credential_id: "target-1".into(),
            credential_name: FleetCredentialName::SshPassword,
            plaintext: FleetCredentialPlaintext::new("secret".into()).unwrap(),
            written_at: "2026-09-15T00:00:00+00:00".into(),
        };
        vault.write_credential(request).unwrap();
        set_private_mode(&vault.key_path, false).unwrap();
        set_private_mode(&vault.state_path, false).unwrap();
    }

    #[cfg(windows)]
    struct TempRoot(PathBuf);

    #[cfg(windows)]
    impl TempRoot {
        fn new() -> Self {
            static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "matcha-fleet-credential-private-{}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    #[cfg(windows)]
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
