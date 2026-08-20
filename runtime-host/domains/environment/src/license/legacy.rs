use std::{fs, io, path::Path};

use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit, generic_array::GenericArray},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use super::{LicenseCacheMetadata, LicenseDeviceIdentity, LicenseKey, LicensePrivateError, crypto};

const SECRET_FILE: &str = "license-secret.enc.json";
const SECRET_BACKUP_FILE: &str = "license-secret.enc.json.bak";
const CACHE_FILE: &str = "matchaclaw-license-cache.json";
const SECRET_VERSION: u8 = 1;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_CACHE_BYTES: usize = 64 * 1024;
const SECRET_MATERIAL_SUFFIX: &str = "matchaclaw-license-v1";
const SECRET_INFO: &[u8] = b"matchaclaw-license-secret-v1";

pub(super) struct LegacyState {
    pub(super) key: LicenseKey,
    pub(super) cache: Option<LicenseCacheMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretFile {
    version: u8,
    alg: String,
    kdf: String,
    salt: String,
    iv: String,
    ciphertext: String,
    tag: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u8,
    key_hash: String,
    device_id: String,
    install_id: Option<String>,
    #[serde(rename = "hardwareId")]
    _hardware_id: Option<String>,
    activated_at_ms: u64,
    last_validated_at_ms: u64,
    offline_grace_until_ms: u64,
    expires_at_ms: Option<u64>,
    refresh_after_sec: Option<u64>,
    #[serde(rename = "licenseId")]
    _license_id: Option<String>,
    plan: Option<String>,
}

pub(super) fn import(
    legacy_root: &Path,
    identity: &LicenseDeviceIdentity,
    product: &str,
) -> Result<Option<LegacyState>, LicensePrivateError> {
    let secret_path = legacy_root.join(SECRET_FILE);
    let secret = match read_file(&secret_path, MAX_SECRET_BYTES)? {
        Some(bytes) => bytes,
        None => return Ok(None),
    };
    let secret_file = serde_json::from_slice::<SecretFile>(&secret)
        .map_err(|_| LicensePrivateError::CorruptState)?;
    let key = decrypt_secret(secret_file, identity, product)?;
    let cache = read_cache(legacy_root, identity, &key);
    Ok(Some(LegacyState { key, cache }))
}

pub(super) fn cleanup(legacy_root: &Path) -> Result<(), LicensePrivateError> {
    for name in [SECRET_FILE, SECRET_BACKUP_FILE, CACHE_FILE] {
        let path = legacy_root.join(name);
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(LicensePrivateError::StorageUnavailable),
        }
    }
    Ok(())
}

fn read_file(path: &Path, max_bytes: usize) -> Result<Option<Vec<u8>>, LicensePrivateError> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= max_bytes => Ok(Some(bytes)),
        Ok(_) => Err(LicensePrivateError::CorruptState),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(LicensePrivateError::StorageUnavailable),
    }
}

fn decrypt_secret(
    file: SecretFile,
    identity: &LicenseDeviceIdentity,
    product: &str,
) -> Result<LicenseKey, LicensePrivateError> {
    if file.version != SECRET_VERSION
        || file.alg != "aes-256-gcm"
        || file.kdf != "hkdf-sha256"
        || file.updated_at.trim().is_empty()
    {
        return Err(LicensePrivateError::CorruptState);
    }

    let salt = decode_fixed::<SALT_BYTES>(&file.salt)?;
    let nonce = decode_fixed::<NONCE_BYTES>(&file.iv)?;
    let ciphertext = decode_base64(&file.ciphertext)?;
    let tag = decode_fixed::<TAG_BYTES>(&file.tag)?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_SECRET_BYTES {
        return Err(LicensePrivateError::CorruptState);
    }

    let material = format!(
        "{product}|{}|{SECRET_MATERIAL_SUFFIX}",
        identity.as_str().to_ascii_lowercase()
    );
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), material.as_bytes());
    let mut key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(SECRET_INFO, &mut *key)
        .map_err(|_| LicensePrivateError::CryptoUnavailable)?;

    let mut authenticated = Vec::with_capacity(ciphertext.len() + tag.len());
    authenticated.extend_from_slice(&ciphertext);
    authenticated.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new(GenericArray::from_slice(&*key));
    let plaintext = cipher
        .decrypt(GenericArray::from_slice(&nonce), authenticated.as_ref())
        .map_err(|_| LicensePrivateError::CorruptState)?;
    let mut plaintext = Zeroizing::new(plaintext);
    let value = std::str::from_utf8(&plaintext)
        .map_err(|_| LicensePrivateError::CorruptState)?
        .trim();
    if value.is_empty() {
        return Err(LicensePrivateError::CorruptState);
    }
    let normalized = Zeroizing::new(value.to_ascii_uppercase());
    let result = LicenseKey::try_new(&*normalized);
    plaintext.zeroize();
    result.map_err(|_| LicensePrivateError::CorruptState)
}

fn read_cache(
    legacy_root: &Path,
    identity: &LicenseDeviceIdentity,
    key: &LicenseKey,
) -> Option<LicenseCacheMetadata> {
    let path = legacy_root.join(CACHE_FILE);
    let bytes = read_file(&path, MAX_CACHE_BYTES).ok()??;
    let cache = serde_json::from_slice::<CacheFile>(&bytes).ok()?;
    if cache.version != SECRET_VERSION
        || cache.key_hash != crypto::hash_key(key)
        || !same_identity(&cache, identity)
        || cache.offline_grace_until_ms < cache.last_validated_at_ms
        || cache
            .expires_at_ms
            .is_some_and(|value| value < cache.last_validated_at_ms)
    {
        return None;
    }
    let revalidate_after_ms = cache.refresh_after_sec.and_then(|seconds| {
        cache
            .last_validated_at_ms
            .checked_add(seconds.saturating_mul(1_000))
    });
    if revalidate_after_ms.is_some_and(|value| value < cache.last_validated_at_ms) {
        return None;
    }
    LicenseCacheMetadata::try_new(
        cache.last_validated_at_ms,
        cache.offline_grace_until_ms,
        cache.expires_at_ms,
        revalidate_after_ms,
    )
    .ok()
}

fn same_identity(cache: &CacheFile, identity: &LicenseDeviceIdentity) -> bool {
    let expected = identity.as_str().trim().to_ascii_lowercase();
    let actual = cache
        .install_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&cache.device_id)
        .trim()
        .to_ascii_lowercase();
    !actual.is_empty() && actual == expected
}

fn decode_base64(value: &str) -> Result<Vec<u8>, LicensePrivateError> {
    STANDARD
        .decode(value.as_bytes())
        .map_err(|_| LicensePrivateError::CorruptState)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], LicensePrivateError> {
    let bytes = decode_base64(value)?;
    if bytes.len() != N {
        return Err(LicensePrivateError::CorruptState);
    }
    let mut output = [0_u8; N];
    output.copy_from_slice(&bytes);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn missing_secret_is_not_a_migration_error() {
        let root = tempfile_root();
        let identity = LicenseDeviceIdentity::try_new("device-a").unwrap();
        assert!(
            import(&root, &identity, "matchaclaw-desktop")
                .unwrap()
                .is_none()
        );
        let _ = fs::remove_dir_all(root);
    }

    fn tempfile_root() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("matcha-license-legacy-{}", std::process::id()));
        let _ = fs::create_dir_all(&path);
        path
    }
}
