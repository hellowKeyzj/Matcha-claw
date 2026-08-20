use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, generic_array::GenericArray},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use getrandom::fill as random_fill;
use sha2::{Digest, Sha256};

use super::{LicenseDeviceIdentity, LicenseKey, LicensePrivateError};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
const HASH_PREFIX: &str = "license-key:";

pub(super) struct EncryptedLicenseKey {
    pub(super) nonce: String,
    pub(super) ciphertext: String,
}

pub(super) fn encrypt(
    storage_key: &[u8; KEY_BYTES],
    device_identity: &LicenseDeviceIdentity,
    key: &LicenseKey,
) -> Result<EncryptedLicenseKey, LicensePrivateError> {
    let cipher = Aes256Gcm::new(GenericArray::from_slice(storage_key));
    let mut nonce = [0_u8; NONCE_BYTES];
    random_fill(&mut nonce).map_err(|_| LicensePrivateError::CryptoUnavailable)?;
    let ciphertext = cipher
        .encrypt(
            GenericArray::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: key.as_bytes(),
                aad: device_identity.as_bytes(),
            },
        )
        .map_err(|_| LicensePrivateError::CryptoUnavailable)?;
    Ok(EncryptedLicenseKey {
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

pub(super) fn validate_encrypted_state(
    nonce: &str,
    ciphertext: &str,
) -> Result<(), LicensePrivateError> {
    let _ = decode_nonce(nonce)?;
    let _ = decode_ciphertext(ciphertext)?;
    Ok(())
}

pub(super) fn decode_nonce(value: &str) -> Result<[u8; NONCE_BYTES], LicensePrivateError> {
    decode_fixed(value)
}

pub(super) fn decode_ciphertext(value: &str) -> Result<Vec<u8>, LicensePrivateError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| LicensePrivateError::CorruptState)?;
    if bytes.len() < AES_GCM_TAG_BYTES {
        return Err(LicensePrivateError::CorruptState);
    }
    Ok(bytes)
}

pub(super) fn decrypt(
    storage_key: &[u8; KEY_BYTES],
    device_identity: &LicenseDeviceIdentity,
    nonce: &str,
    ciphertext: &str,
) -> Result<LicenseKey, LicensePrivateError> {
    let nonce = decode_nonce(nonce)?;
    let ciphertext = decode_ciphertext(ciphertext)?;
    let cipher = Aes256Gcm::new(GenericArray::from_slice(storage_key));
    let bytes = cipher
        .decrypt(
            GenericArray::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &ciphertext,
                aad: device_identity.as_bytes(),
            },
        )
        .map_err(|_| LicensePrivateError::CorruptState)?;
    LicenseKey::from_plaintext(bytes)
}

pub(super) fn hash_key(key: &LicenseKey) -> String {
    let mut digest = Sha256::new();
    digest.update(HASH_PREFIX.as_bytes());
    digest.update(key.as_bytes());
    hex(&digest.finalize())
}

pub(super) fn hash_device_identity(identity: &LicenseDeviceIdentity) -> String {
    let mut digest = Sha256::new();
    digest.update(b"license-device:");
    digest.update(identity.as_bytes());
    hex(&digest.finalize())
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], LicensePrivateError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| LicensePrivateError::CorruptState)?;
    if bytes.len() != N {
        return Err(LicensePrivateError::CorruptState);
    }
    let mut output = [0_u8; N];
    output.copy_from_slice(&bytes);
    Ok(output)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_with_authenticated_device_binding() {
        let key = [7_u8; KEY_BYTES];
        let device = LicenseDeviceIdentity::try_new("device-a").unwrap();
        let license = LicenseKey::try_new("MATCHACLAW-PRIVATE").unwrap();
        let encrypted = encrypt(&key, &device, &license).unwrap();
        assert!(!encrypted.ciphertext.contains("MATCHACLAW-PRIVATE"));
        assert_eq!(
            decrypt(&key, &device, &encrypted.nonce, &encrypted.ciphertext),
            Ok(license)
        );

        let other_device = LicenseDeviceIdentity::try_new("device-b").unwrap();
        assert_eq!(
            decrypt(&key, &other_device, &encrypted.nonce, &encrypted.ciphertext),
            Err(LicensePrivateError::CorruptState)
        );
    }

    #[test]
    fn key_hash_is_domain_prefixed() {
        let license = LicenseKey::try_new("MATCHACLAW-PRIVATE").unwrap();
        assert_eq!(
            hash_key(&license),
            "343da8e450f74288955c2f68ef7cf7b363637c3a0295f76a103c4925b2b20e75"
        );
    }

    #[test]
    fn raw_key_debug_is_redacted() {
        let license = LicenseKey::try_new("MATCHACLAW-PRIVATE").unwrap();
        assert!(!format!("{license:?}").contains("MATCHACLAW-PRIVATE"));
    }
}
