use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload, generic_array::GenericArray},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use getrandom::fill as random_fill;
use rsa::{
    Oaep, RsaPublicKey,
    pkcs8::DecodePublicKey,
    rand_core::{TryCryptoRng, TryRng},
    sha2::Sha256,
    traits::PaddingScheme,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256 as DigestSha256};
use std::convert::Infallible;
use zeroize::Zeroize;

use crate::api::{SealedPackageAuthorizationKey, SealedResourceError};

pub(crate) const PACKAGE_FORMAT_VERSION: u8 = 1;

const PAYLOAD_ALGORITHM: &str = "aes-256-gcm";
const CLOUD_ENVELOPE_ALGORITHM: &str = "rsa-oaep-sha256";
const LOCAL_ENVELOPE_ALGORITHM: &str = "local";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SealedPackageWire<M> {
    pub(crate) format: String,
    pub(crate) version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) skill_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<String>,
    pub(crate) manifest_sha256: String,
    pub(crate) manifest: M,
    pub(crate) payload: EncryptedPayload,
    pub(crate) cloud_envelope: CloudEnvelope,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudEnvelope {
    key_id: String,
    algorithm: String,
    ciphertext_base64: String,
}

impl CloudEnvelope {
    fn local() -> Self {
        Self {
            key_id: "local".to_owned(),
            algorithm: LOCAL_ENVELOPE_ALGORITHM.to_owned(),
            ciphertext_base64: String::new(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncryptedPayload {
    algorithm: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SealedPayloadEntry {
    pub(crate) path: String,
    pub(crate) data_base64: String,
}

pub(crate) struct SealedPayloadSeal {
    pub(crate) authorization_key: SealedPackageAuthorizationKey,
    pub(crate) cloud_envelope: CloudEnvelope,
    pub(crate) payload: EncryptedPayload,
}

pub(crate) fn seal_payload_entries(
    format: &str,
    manifest_sha256: &str,
    entries: &[SealedPayloadEntry],
) -> Result<SealedPayloadSeal, SealedResourceError> {
    seal_payload_entries_with_cloud_key(format, manifest_sha256, entries, None, None)
}

pub(crate) fn seal_payload_entries_with_cloud_key(
    format: &str,
    manifest_sha256: &str,
    entries: &[SealedPayloadEntry],
    cloud_public_key: Option<&str>,
    cloud_key_id: Option<&str>,
) -> Result<SealedPayloadSeal, SealedResourceError> {
    let mut plaintext = serde_json::to_vec(entries).map_err(|_| SealedResourceError::Unknown)?;
    let sealed = seal_payload_bytes(
        format,
        manifest_sha256,
        &plaintext,
        cloud_public_key,
        cloud_key_id,
    );
    plaintext.zeroize();
    sealed
}

pub(crate) fn open_payload_entries(
    format: &str,
    manifest_sha256: &str,
    payload: EncryptedPayload,
    authorization_key: &SealedPackageAuthorizationKey,
) -> Result<Vec<SealedPayloadEntry>, SealedResourceError> {
    open_payload(format, manifest_sha256, payload, authorization_key)
}

pub(crate) fn hex_digest(bytes: &[u8]) -> String {
    DigestSha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn seal_payload_bytes(
    format: &str,
    manifest_sha256: &str,
    plaintext: &[u8],
    cloud_public_key: Option<&str>,
    cloud_key_id: Option<&str>,
) -> Result<SealedPayloadSeal, SealedResourceError> {
    let authorization_key = SealedPackageAuthorizationKey::generate()?;
    let sealed = (|| {
        let aad = package_aad(format, manifest_sha256)?;
        let payload = encrypt_payload(authorization_key.as_bytes(), &aad, plaintext)?;
        let cloud_envelope = match cloud_public_key {
            Some(public_key) => encrypt_cloud_envelope(
                public_key,
                cloud_key_id.ok_or(SealedResourceError::Rejected)?,
                authorization_key.as_bytes(),
            )?,
            None => CloudEnvelope::local(),
        };
        Ok(SealedPayloadSeal {
            authorization_key,
            cloud_envelope,
            payload,
        })
    })();
    sealed
}

fn open_payload<T: DeserializeOwned>(
    format: &str,
    manifest_sha256: &str,
    payload: EncryptedPayload,
    authorization_key: &SealedPackageAuthorizationKey,
) -> Result<T, SealedResourceError> {
    let aad = package_aad(format, manifest_sha256)?;
    let mut plaintext = decrypt_payload(authorization_key.as_bytes(), &aad, payload)?;
    let decoded = serde_json::from_slice(&plaintext).map_err(|_| {
        plaintext.zeroize();
        SealedResourceError::Rejected
    })?;
    plaintext.zeroize();
    Ok(decoded)
}

fn encrypt_cloud_envelope(
    public_key_pem: &str,
    key_id: &str,
    authorization_key: &[u8; KEY_BYTES],
) -> Result<CloudEnvelope, SealedResourceError> {
    let key_id = key_id.trim();
    if key_id.is_empty() {
        return Err(SealedResourceError::Rejected);
    }
    let public_key = RsaPublicKey::from_public_key_pem(public_key_pem)
        .map_err(|_| SealedResourceError::Rejected)?;
    let mut rng = SystemRng;
    let ciphertext = Oaep::<Sha256>::new()
        .encrypt(&mut rng, &public_key, authorization_key)
        .map_err(|_| SealedResourceError::Unknown)?;
    Ok(CloudEnvelope {
        key_id: key_id.to_owned(),
        algorithm: CLOUD_ENVELOPE_ALGORITHM.to_owned(),
        ciphertext_base64: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

fn encrypt_payload(
    key: &[u8; KEY_BYTES],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<EncryptedPayload, SealedResourceError> {
    let encrypted = encrypt_bytes(key, aad, plaintext)?;
    Ok(EncryptedPayload {
        algorithm: PAYLOAD_ALGORITHM.to_owned(),
        nonce_base64: encrypted.nonce_base64,
        ciphertext_base64: encrypted.ciphertext_base64,
    })
}

fn decrypt_payload(
    key: &[u8; KEY_BYTES],
    aad: &[u8],
    payload: EncryptedPayload,
) -> Result<Vec<u8>, SealedResourceError> {
    if payload.algorithm != PAYLOAD_ALGORITHM {
        return Err(SealedResourceError::Rejected);
    }
    decrypt_bytes(key, aad, payload.nonce_base64, payload.ciphertext_base64)
}

fn encrypt_bytes(
    key: &[u8; KEY_BYTES],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<EncryptedBytes, SealedResourceError> {
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let mut nonce = [0_u8; NONCE_BYTES];
    random_fill(&mut nonce).map_err(|_| SealedResourceError::Unknown)?;
    let ciphertext = cipher
        .encrypt(
            GenericArray::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| SealedResourceError::Unknown)?;
    let encrypted = EncryptedBytes {
        nonce_base64: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext_base64: URL_SAFE_NO_PAD.encode(ciphertext),
    };
    nonce.zeroize();
    Ok(encrypted)
}

fn decrypt_bytes(
    key: &[u8; KEY_BYTES],
    aad: &[u8],
    nonce_base64: String,
    ciphertext_base64: String,
) -> Result<Vec<u8>, SealedResourceError> {
    let nonce = decode_fixed::<NONCE_BYTES>(&nonce_base64)?;
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(ciphertext_base64.as_bytes())
        .map_err(|_| SealedResourceError::Rejected)?;
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let plaintext = cipher
        .decrypt(
            GenericArray::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| SealedResourceError::Rejected);
    ciphertext.zeroize();
    plaintext
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], SealedResourceError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| SealedResourceError::Rejected)?;
    bytes.try_into().map_err(|_| SealedResourceError::Rejected)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageAad<'a> {
    format: &'a str,
    version: u8,
    manifest_sha256: &'a str,
}

fn package_aad(format: &str, manifest_sha256: &str) -> Result<Vec<u8>, SealedResourceError> {
    serde_json::to_vec(&PackageAad {
        format,
        version: PACKAGE_FORMAT_VERSION,
        manifest_sha256,
    })
    .map_err(|_| SealedResourceError::Unknown)
}

struct EncryptedBytes {
    nonce_base64: String,
    ciphertext_base64: String,
}

struct SystemRng;

impl TryRng for SystemRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut bytes = [0_u8; 4];
        random_fill(&mut bytes).expect("system randomness is unavailable");
        Ok(u32::from_le_bytes(bytes))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut bytes = [0_u8; 8];
        random_fill(&mut bytes).expect("system randomness is unavailable");
        Ok(u64::from_le_bytes(bytes))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        random_fill(dst).expect("system randomness is unavailable");
        Ok(())
    }
}

impl TryCryptoRng for SystemRng {}
