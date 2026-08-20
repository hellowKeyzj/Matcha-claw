use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use getrandom::fill as random_fill;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{
    LicenseCacheMetadata, LicenseDeviceIdentity, LicenseKey, LicensePrivateError,
    LicenseProjection, LicenseProjectionReason, LicenseProjectionState,
};
use crate::license::crypto;

const STATE_VERSION: u8 = 1;
const STORAGE_KEY_BYTES: usize = 32;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const STATE_DIRECTORY: &str = "license";
const STATE_FILE: &str = "private-state.v1.json";
const STORAGE_KEY_FILE: &str = "private-key";
const DEVICE_IDENTITY_FILE: &str = "device-identity";
const DEVICE_IDENTITY_BYTES: usize = 32;

/// Private source-backed license state. It has no network client and no public
/// route responsibility.
pub(crate) struct LicensePrivateStore {
    directory: PathBuf,
    state_path: PathBuf,
    storage_key_path: PathBuf,
    lock: Mutex<()>,
}

impl LicensePrivateStore {
    pub(crate) fn open(private_root: impl AsRef<Path>) -> Result<Self, LicensePrivateError> {
        let private_root = private_root.as_ref();
        if !private_root.is_absolute() {
            return Err(LicensePrivateError::InvalidInput);
        }
        let directory = private_root.join(STATE_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|_| LicensePrivateError::StorageUnavailable)?;
        set_private_mode(&directory, true)?;
        Ok(Self {
            state_path: directory.join(STATE_FILE),
            storage_key_path: directory.join(STORAGE_KEY_FILE),
            directory,
            lock: Mutex::new(()),
        })
    }

    pub(crate) fn has_state(&self) -> Result<bool, LicensePrivateError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        match fs::metadata(&self.state_path) {
            Ok(metadata) if metadata.is_file() => Ok(true),
            Ok(_) => Err(LicensePrivateError::StorageUnavailable),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(LicensePrivateError::StorageUnavailable),
        }
    }

    pub(crate) fn store_key(
        &self,
        device_identity: &LicenseDeviceIdentity,
        key: LicenseKey,
        cache: Option<LicenseCacheMetadata>,
    ) -> Result<(), LicensePrivateError> {
        if let Some(cache) = cache {
            cache.validate()?;
        }
        let _guard = self
            .lock
            .lock()
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        let storage_key = self.create_storage_key()?;
        let encrypted = crypto::encrypt(&storage_key, device_identity, &key)?;
        let state = PersistedState {
            version: STATE_VERSION,
            key_hash: crypto::hash_key(&key),
            device_identity_hash: crypto::hash_device_identity(device_identity),
            nonce: encrypted.nonce,
            ciphertext: encrypted.ciphertext,
            cache: cache.map(PersistedCache::from_metadata),
        };
        self.write_state(&state)
    }

    pub(crate) fn read_key(
        &self,
        device_identity: &LicenseDeviceIdentity,
    ) -> Result<LicenseKey, LicensePrivateError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        let state = self.read_state()?.ok_or(LicensePrivateError::NoStoredKey)?;
        self.read_key_from_state(&state, device_identity)
    }

    pub(crate) fn snapshot(
        &self,
        device_identity: &LicenseDeviceIdentity,
        now_ms: u64,
    ) -> LicenseProjection {
        match self.snapshot_inner(device_identity, now_ms) {
            Ok(projection) => projection,
            Err(error) => error.projection(),
        }
    }

    pub(crate) fn clear(&self) -> Result<(), LicensePrivateError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        remove_private_file(&self.state_path)?;
        remove_private_file(&self.storage_key_path)
    }

    fn snapshot_inner(
        &self,
        device_identity: &LicenseDeviceIdentity,
        now_ms: u64,
    ) -> Result<LicenseProjection, LicensePrivateError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        let state = self.read_state()?.ok_or(LicensePrivateError::NoStoredKey)?;
        let _key = self.read_key_from_state(&state, device_identity)?;
        let cache = state.cache.ok_or(LicensePrivateError::NoCachedValidation)?;
        let cache = cache.to_metadata()?;
        if cache
            .expires_at_ms()
            .is_some_and(|expires_at| now_ms >= expires_at)
        {
            return Err(LicensePrivateError::Expired);
        }
        let revalidation_due = cache
            .revalidate_after_ms()
            .is_some_and(|revalidate_after| now_ms >= revalidate_after);
        let usable = now_ms < cache.offline_grace_until_ms();
        Ok(LicenseProjection {
            state: if usable {
                LicenseProjectionState::CacheBacked
            } else {
                LicenseProjectionState::Unavailable
            },
            reason: if usable {
                if revalidation_due {
                    LicenseProjectionReason::RevalidationDue
                } else {
                    LicenseProjectionReason::CacheGraceValid
                }
            } else {
                LicenseProjectionReason::NoCachedValidation
            },
            has_stored_key: true,
            has_usable_cache: usable,
            last_validated_at_ms: Some(cache.last_validated_at_ms()),
            expires_at_ms: cache.expires_at_ms(),
            offline_grace_until_ms: Some(cache.offline_grace_until_ms()),
            revalidate_after_ms: cache.revalidate_after_ms(),
            revalidation_due,
        })
    }

    fn read_key_from_state(
        &self,
        state: &PersistedState,
        device_identity: &LicenseDeviceIdentity,
    ) -> Result<LicenseKey, LicensePrivateError> {
        let expected_device_identity_hash = crypto::hash_device_identity(device_identity);
        if state.device_identity_hash != expected_device_identity_hash {
            return Err(LicensePrivateError::IdentityMismatch);
        }
        let storage_key = self.read_storage_key()?;
        let key = crypto::decrypt(
            &storage_key,
            device_identity,
            &state.nonce,
            &state.ciphertext,
        )?;
        if state.key_hash != crypto::hash_key(&key) {
            return Err(LicensePrivateError::KeyHashMismatch);
        }
        Ok(key)
    }

    fn create_storage_key(
        &self,
    ) -> Result<Zeroizing<[u8; STORAGE_KEY_BYTES]>, LicensePrivateError> {
        let mut key = Zeroizing::new([0_u8; STORAGE_KEY_BYTES]);
        random_fill(&mut *key).map_err(|_| LicensePrivateError::CryptoUnavailable)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.storage_key_path)
        {
            Ok(mut file) => {
                set_private_mode(&self.storage_key_path, false)?;
                file.write_all(&*key)
                    .and_then(|()| file.sync_all())
                    .map_err(|_| LicensePrivateError::StorageUnavailable)?;
                Ok(key)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => self.read_storage_key(),
            Err(_) => Err(LicensePrivateError::StorageUnavailable),
        }
    }

    fn read_storage_key(&self) -> Result<Zeroizing<[u8; STORAGE_KEY_BYTES]>, LicensePrivateError> {
        let bytes = Zeroizing::new(fs::read(&self.storage_key_path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                LicensePrivateError::CorruptState
            } else {
                LicensePrivateError::StorageUnavailable
            }
        })?);
        decode_fixed(&bytes).map(Zeroizing::new)
    }

    fn read_state(&self) -> Result<Option<PersistedState>, LicensePrivateError> {
        let mut file = match File::open(&self.state_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(LicensePrivateError::StorageUnavailable),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| LicensePrivateError::StorageUnavailable)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(LicensePrivateError::CorruptState);
        }
        let state = serde_json::from_slice::<PersistedState>(&bytes)
            .map_err(|_| LicensePrivateError::CorruptState)?;
        state.validate()?;
        Ok(Some(state))
    }

    fn write_state(&self, state: &PersistedState) -> Result<(), LicensePrivateError> {
        let bytes =
            serde_json::to_vec(state).map_err(|_| LicensePrivateError::StorageUnavailable)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(LicensePrivateError::CorruptState);
        }
        let mut suffix = [0_u8; 8];
        random_fill(&mut suffix).map_err(|_| LicensePrivateError::CryptoUnavailable)?;
        let temporary = self.directory.join(format!(
            "private-state.{}.tmp",
            URL_SAFE_NO_PAD.encode(suffix)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| LicensePrivateError::StorageUnavailable)?;
            set_private_mode(&temporary, false)?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| LicensePrivateError::StorageUnavailable)?;
            replace_file(&temporary, &self.state_path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[derive(Deserialize, Serialize)]
struct PersistedState {
    version: u8,
    key_hash: String,
    device_identity_hash: String,
    nonce: String,
    ciphertext: String,
    cache: Option<PersistedCache>,
}

impl PersistedState {
    fn validate(&self) -> Result<(), LicensePrivateError> {
        if self.version != STATE_VERSION
            || !is_hex_digest(&self.key_hash)
            || !is_hex_digest(&self.device_identity_hash)
            || crypto::validate_encrypted_state(&self.nonce, &self.ciphertext).is_err()
        {
            return Err(LicensePrivateError::CorruptState);
        }
        if let Some(cache) = self.cache.as_ref() {
            cache.to_metadata()?;
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct PersistedCache {
    last_validated_at_ms: u64,
    offline_grace_until_ms: u64,
    expires_at_ms: Option<u64>,
    revalidate_after_ms: Option<u64>,
}

impl PersistedCache {
    fn from_metadata(metadata: LicenseCacheMetadata) -> Self {
        Self {
            last_validated_at_ms: metadata.last_validated_at_ms(),
            offline_grace_until_ms: metadata.offline_grace_until_ms(),
            expires_at_ms: metadata.expires_at_ms(),
            revalidate_after_ms: metadata.revalidate_after_ms(),
        }
    }

    fn to_metadata(&self) -> Result<LicenseCacheMetadata, LicensePrivateError> {
        LicenseCacheMetadata::try_new(
            self.last_validated_at_ms,
            self.offline_grace_until_ms,
            self.expires_at_ms,
            self.revalidate_after_ms,
        )
    }
}

fn decode_fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N], LicensePrivateError> {
    if bytes.len() != N {
        return Err(LicensePrivateError::CorruptState);
    }
    let mut output = [0_u8; N];
    output.copy_from_slice(bytes);
    Ok(output)
}

fn is_hex_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn remove_private_file(path: &Path) -> Result<(), LicensePrivateError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LicensePrivateError::StorageUnavailable),
    }
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), LicensePrivateError> {
    fs::rename(temporary, destination).map_err(|_| LicensePrivateError::StorageUnavailable)
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), LicensePrivateError> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|_| LicensePrivateError::StorageUnavailable)?;
    }
    fs::rename(temporary, destination).map_err(|_| LicensePrivateError::StorageUnavailable)
}

#[cfg(unix)]
fn set_private_mode(path: &Path, directory: bool) -> Result<(), LicensePrivateError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if directory { 0o700 } else { 0o600 };
    let mut permissions = fs::metadata(path)
        .map_err(|_| LicensePrivateError::StorageUnavailable)?
        .permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).map_err(|_| LicensePrivateError::StorageUnavailable)
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _directory: bool) -> Result<(), LicensePrivateError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn store() -> (LicensePrivateStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "matcha-license-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        (LicensePrivateStore::open(&root).unwrap(), root)
    }

    fn identity() -> LicenseDeviceIdentity {
        LicenseDeviceIdentity::try_new("test-device").unwrap()
    }

    fn cache(
        grace_until: u64,
        expires_at: Option<u64>,
        revalidate_after: Option<u64>,
    ) -> LicenseCacheMetadata {
        LicenseCacheMetadata::try_new(100, grace_until, expires_at, revalidate_after).unwrap()
    }

    #[test]
    fn stores_only_ciphertext_and_projects_cache_backed_state() {
        let (store, root) = store();
        store
            .store_key(
                &identity(),
                LicenseKey::try_new("MATCHACLAW-PRIVATE").unwrap(),
                Some(cache(2_000, Some(5_000), Some(1_500))),
            )
            .unwrap();
        let encoded = fs::read(root.join(STATE_DIRECTORY).join(STATE_FILE)).unwrap();
        let text = String::from_utf8(encoded).unwrap();
        assert!(!text.contains("MATCHACLAW-PRIVATE"));
        assert_eq!(
            store.snapshot(&identity(), 1_000),
            LicenseProjection {
                state: LicenseProjectionState::CacheBacked,
                reason: LicenseProjectionReason::CacheGraceValid,
                has_stored_key: true,
                has_usable_cache: true,
                last_validated_at_ms: Some(100),
                expires_at_ms: Some(5_000),
                offline_grace_until_ms: Some(2_000),
                revalidate_after_ms: Some(1_500),
                revalidation_due: false,
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn distinguishes_revalidation_expiry_and_identity_mismatch() {
        let (store, root) = store();
        store
            .store_key(
                &identity(),
                LicenseKey::try_new("MATCHACLAW-PRIVATE").unwrap(),
                Some(cache(2_000, Some(5_000), Some(1_500))),
            )
            .unwrap();
        assert_eq!(
            store.snapshot(&identity(), 1_500).reason,
            LicenseProjectionReason::RevalidationDue
        );
        assert_eq!(
            store.snapshot(&identity(), 5_000).state,
            LicenseProjectionState::Expired
        );
        let other = LicenseDeviceIdentity::try_new("other-device").unwrap();
        assert_eq!(
            store.snapshot(&other, 1_000).reason,
            LicenseProjectionReason::IdentityMismatch
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_state_projects_unknown_without_private_details() {
        let (store, root) = store();
        fs::write(&store.state_path, b"not-json").unwrap();
        let projection = store.snapshot(&identity(), 1_000);
        assert_eq!(projection.state, LicenseProjectionState::Unknown);
        assert_eq!(projection.reason, LicenseProjectionReason::CorruptState);
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }
}
