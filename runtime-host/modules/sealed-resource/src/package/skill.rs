use std::fmt;

use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload, generic_array::GenericArray},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use getrandom::fill as random_fill;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    api::{SealedResourceError, SealedSkillTarget},
    descriptor::SealedSkillDescriptor,
    domain::{PackageRelativePath, SkillKey},
};

const PACKAGE_FORMAT: &str = "matcha-skillpkg";
const PACKAGE_FORMAT_VERSION: u8 = 1;
const PAYLOAD_ALGORITHM: &str = "aes-256-gcm";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const MAX_PACKAGE_FILES: usize = 64;
const MAX_FILE_BYTES: usize = 48 * 1024;
const MAX_PACKAGE_BYTES: usize = 48 * 1024;
const SEALED_SKILL_PACKAGE_EXTENSION: &str = "matcha-skillpkg";

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealedSkillFileRequest {
    path: PackageRelativePath,
    content: Vec<u8>,
}

impl SealedSkillFileRequest {
    pub(crate) fn try_new(
        path: impl Into<String>,
        content: impl Into<Vec<u8>>,
    ) -> Result<Self, SealedResourceError> {
        let path =
            PackageRelativePath::parse(path.into()).map_err(|_| SealedResourceError::Rejected)?;
        let content = content.into();
        if content.len() > MAX_FILE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        Ok(Self { path, content })
    }

    pub(crate) fn path(&self) -> &PackageRelativePath {
        &self.path
    }

    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }
}

impl fmt::Debug for SealedSkillFileRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillFileRequest")
            .field("path", &self.path)
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealedSkillFile {
    path: PackageRelativePath,
    content: Vec<u8>,
}

impl SealedSkillFile {
    pub(crate) fn path(&self) -> &PackageRelativePath {
        &self.path
    }

    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }
}

impl fmt::Debug for SealedSkillFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedSkillFile")
            .field("path", &self.path)
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedSkillPackage {
    skill_key: SkillKey,
    target: SealedSkillTarget,
    descriptor: SealedSkillDescriptor,
    package_sha256: String,
    files: Vec<SealedSkillFile>,
}

impl SealedSkillPackage {
    pub(crate) fn seal(
        skill_key: SkillKey,
        target: SealedSkillTarget,
        files: Vec<SealedSkillFileRequest>,
        key: &[u8],
    ) -> Result<SealSkillPackageReceipt, SealedResourceError> {
        let files = normalize_files(files)?;
        let descriptor = descriptor_from_files(&files)?;
        let manifest = PackageManifest::from_files(&skill_key, target, &descriptor, &files)?;
        let mut plaintext = payload_plaintext(&files)?;
        let payload = encrypt_payload(
            key,
            &payload_aad(skill_key.as_str(), target, manifest.sha256.as_str())?,
            &plaintext,
        )?;
        plaintext.zeroize();
        let wire = SealedPackageWire {
            format: PACKAGE_FORMAT.to_owned(),
            version: PACKAGE_FORMAT_VERSION,
            skill_key: skill_key.as_str().to_owned(),
            target: target.as_str().to_owned(),
            manifest_sha256: manifest.sha256.clone(),
            manifest,
            payload,
        };
        let bytes = serde_json::to_vec(&wire).map_err(|_| SealedResourceError::Unknown)?;
        Ok(SealSkillPackageReceipt::from_package_bytes(bytes))
    }

    pub(crate) fn open(bytes: &[u8], key: &[u8]) -> Result<Self, SealedResourceError> {
        let wire: SealedPackageWire =
            serde_json::from_slice(bytes).map_err(|_| SealedResourceError::Rejected)?;
        if wire.format != PACKAGE_FORMAT || wire.version != PACKAGE_FORMAT_VERSION {
            return Err(SealedResourceError::Rejected);
        }
        let skill_key =
            SkillKey::parse(wire.skill_key).map_err(|_| SealedResourceError::Rejected)?;
        let target = parse_skill_target_code(&wire.target)?;
        if wire.manifest.skill_key != skill_key.as_str()
            || wire.manifest.target != target
            || wire.manifest_sha256 != wire.manifest.sha256
            || manifest_digest(&wire.manifest)? != wire.manifest.sha256
        {
            return Err(SealedResourceError::Rejected);
        }
        let payload = decrypt_payload(
            key,
            &payload_aad(skill_key.as_str(), target, wire.manifest_sha256.as_str())?,
            wire.payload,
        )?;
        let files = open_payload(payload, &wire.manifest)?;
        let descriptor = descriptor_from_files(&files)?;
        if wire.manifest.descriptor != ManifestDescriptor::from_descriptor(&descriptor) {
            return Err(SealedResourceError::Rejected);
        }
        Ok(Self {
            skill_key,
            target,
            descriptor,
            package_sha256: hex_digest(bytes),
            files,
        })
    }

    pub(crate) fn skill_key(&self) -> &SkillKey {
        &self.skill_key
    }

    pub(crate) fn target(&self) -> SealedSkillTarget {
        self.target
    }

    pub(crate) fn descriptor(&self) -> &SealedSkillDescriptor {
        &self.descriptor
    }

    pub(crate) fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub(crate) fn files(&self) -> &[SealedSkillFile] {
        &self.files
    }

    pub(crate) fn file(&self, path: &PackageRelativePath) -> Option<&SealedSkillFile> {
        self.files.iter().find(|file| file.path == *path)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealSkillPackageReceipt {
    package_file_name: String,
    package_sha256: String,
    package_bytes: Vec<u8>,
}

impl SealSkillPackageReceipt {
    pub(crate) fn from_package_bytes(package_bytes: Vec<u8>) -> Self {
        let package_sha256 = hex_digest(&package_bytes);
        let package_file_name = format!("{}.{}", package_sha256, SEALED_SKILL_PACKAGE_EXTENSION);
        Self {
            package_file_name,
            package_sha256,
            package_bytes,
        }
    }

    pub(crate) fn package_file_name(&self) -> &str {
        &self.package_file_name
    }

    pub(crate) fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub(crate) fn package_bytes(&self) -> &[u8] {
        &self.package_bytes
    }

    pub(crate) fn into_package_bytes(self) -> Vec<u8> {
        self.package_bytes
    }
}

impl fmt::Debug for SealSkillPackageReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealSkillPackageReceipt")
            .field("package_file_name", &self.package_file_name)
            .field("package_sha256", &self.package_sha256)
            .field(
                "package_bytes",
                &format_args!("[REDACTED:{} bytes]", self.package_bytes.len()),
            )
            .finish()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedPackageWire {
    format: String,
    version: u8,
    skill_key: String,
    target: String,
    manifest_sha256: String,
    manifest: PackageManifest,
    payload: EncryptedPayload,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayload {
    algorithm: String,
    nonce_base64: String,
    ciphertext_base64: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    skill_key: String,
    #[serde(
        deserialize_with = "deserialize_skill_target_code",
        serialize_with = "serialize_skill_target_code"
    )]
    target: SealedSkillTarget,
    descriptor: ManifestDescriptor,
    files: Vec<PackageManifestFile>,
    sha256: String,
}

impl PackageManifest {
    fn from_files(
        skill_key: &SkillKey,
        target: SealedSkillTarget,
        descriptor: &SealedSkillDescriptor,
        files: &[SealedSkillFile],
    ) -> Result<Self, SealedResourceError> {
        let mut manifest = Self {
            skill_key: skill_key.as_str().to_owned(),
            target,
            descriptor: ManifestDescriptor::from_descriptor(descriptor),
            files: files
                .iter()
                .map(|file| PackageManifestFile {
                    path: file.path.as_str().to_owned(),
                    size_bytes: file.content.len() as u64,
                    sha256: hex_digest(&file.content),
                })
                .collect(),
            sha256: String::new(),
        };
        manifest.sha256 = manifest_digest(&manifest)?;
        Ok(manifest)
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestDescriptor {
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_model_invocation: Option<bool>,
}

impl ManifestDescriptor {
    fn from_descriptor(descriptor: &SealedSkillDescriptor) -> Self {
        Self {
            name: descriptor.name().to_owned(),
            description: descriptor.description().to_owned(),
            user_invocable: descriptor.user_invocable(),
            disable_model_invocation: descriptor.disable_model_invocation(),
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifestFile {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedPayloadEntry {
    path: String,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadAad<'a> {
    format: &'a str,
    version: u8,
    skill_key: &'a str,
    #[serde(serialize_with = "serialize_skill_target_code")]
    target: SealedSkillTarget,
    manifest_sha256: &'a str,
}

fn parse_skill_target_code(value: &str) -> Result<SealedSkillTarget, SealedResourceError> {
    match value {
        "openclaw" => Ok(SealedSkillTarget::OpenClaw),
        _ => Err(SealedResourceError::Rejected),
    }
}

fn serialize_skill_target_code<S>(
    target: &SealedSkillTarget,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(target.as_str())
}

fn deserialize_skill_target_code<'de, D>(deserializer: D) -> Result<SealedSkillTarget, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_skill_target_code(&value)
        .map_err(|_| serde::de::Error::custom("invalid sealed skill target"))
}

fn normalize_files(
    files: Vec<SealedSkillFileRequest>,
) -> Result<Vec<SealedSkillFile>, SealedResourceError> {
    if files.is_empty() || files.len() > MAX_PACKAGE_FILES {
        return Err(SealedResourceError::Rejected);
    }
    let mut normalized = Vec::with_capacity(files.len());
    let mut total_bytes = 0usize;
    for file in files {
        if normalized
            .iter()
            .any(|existing: &SealedSkillFile| existing.path == file.path)
        {
            return Err(SealedResourceError::Rejected);
        }
        total_bytes = total_bytes
            .checked_add(file.content.len())
            .ok_or(SealedResourceError::Rejected)?;
        if total_bytes > MAX_PACKAGE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        normalized.push(SealedSkillFile {
            path: file.path,
            content: file.content,
        });
    }
    normalized.sort_by(|left, right| left.path.cmp(&right.path));
    if !normalized
        .iter()
        .any(|file| file.path == PackageRelativePath::skill_manifest())
    {
        return Err(SealedResourceError::Rejected);
    }
    Ok(normalized)
}

fn descriptor_from_files(
    files: &[SealedSkillFile],
) -> Result<SealedSkillDescriptor, SealedResourceError> {
    let manifest_path = PackageRelativePath::skill_manifest();
    let manifest = files
        .iter()
        .find(|file| file.path == manifest_path)
        .ok_or(SealedResourceError::Rejected)?;
    let content =
        std::str::from_utf8(&manifest.content).map_err(|_| SealedResourceError::Rejected)?;
    SealedSkillDescriptor::parse_skill_manifest(content).map_err(|_| SealedResourceError::Rejected)
}

fn payload_plaintext(files: &[SealedSkillFile]) -> Result<Vec<u8>, SealedResourceError> {
    serde_json::to_vec(
        &files
            .iter()
            .map(|file| SealedPayloadEntry {
                path: file.path.as_str().to_owned(),
                data_base64: STANDARD.encode(&file.content),
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|_| SealedResourceError::Unknown)
}

fn open_payload(
    payload: Vec<SealedPayloadEntry>,
    manifest: &PackageManifest,
) -> Result<Vec<SealedSkillFile>, SealedResourceError> {
    if payload.len() != manifest.files.len()
        || payload.is_empty()
        || payload.len() > MAX_PACKAGE_FILES
    {
        return Err(SealedResourceError::Rejected);
    }
    let mut files = Vec::with_capacity(payload.len());
    let mut total_bytes = 0usize;
    for entry in payload {
        let path =
            PackageRelativePath::parse(entry.path).map_err(|_| SealedResourceError::Rejected)?;
        if files
            .iter()
            .any(|existing: &SealedSkillFile| existing.path == path)
        {
            return Err(SealedResourceError::Rejected);
        }
        let content = STANDARD
            .decode(entry.data_base64.as_bytes())
            .map_err(|_| SealedResourceError::Rejected)?;
        if content.len() > MAX_FILE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        total_bytes = total_bytes
            .checked_add(content.len())
            .ok_or(SealedResourceError::Rejected)?;
        if total_bytes > MAX_PACKAGE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        let Some(expected) = manifest
            .files
            .iter()
            .find(|file| file.path == path.as_str())
        else {
            return Err(SealedResourceError::Rejected);
        };
        if expected.size_bytes != content.len() as u64 || expected.sha256 != hex_digest(&content) {
            return Err(SealedResourceError::Rejected);
        }
        files.push(SealedSkillFile { path, content });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn encrypt_payload(
    key: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<EncryptedPayload, SealedResourceError> {
    if key.len() != KEY_BYTES {
        return Err(SealedResourceError::Rejected);
    }
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
    let payload = EncryptedPayload {
        algorithm: PAYLOAD_ALGORITHM.to_owned(),
        nonce_base64: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext_base64: URL_SAFE_NO_PAD.encode(ciphertext),
    };
    nonce.zeroize();
    Ok(payload)
}

fn decrypt_payload(
    key: &[u8],
    aad: &[u8],
    payload: EncryptedPayload,
) -> Result<Vec<SealedPayloadEntry>, SealedResourceError> {
    if key.len() != KEY_BYTES || payload.algorithm != PAYLOAD_ALGORITHM {
        return Err(SealedResourceError::Rejected);
    }
    let nonce = decode_fixed::<NONCE_BYTES>(&payload.nonce_base64)?;
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(payload.ciphertext_base64.as_bytes())
        .map_err(|_| SealedResourceError::Rejected)?;
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let mut plaintext = cipher
        .decrypt(
            GenericArray::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| SealedResourceError::Rejected)?;
    ciphertext.zeroize();
    let decoded = serde_json::from_slice(&plaintext).map_err(|_| {
        plaintext.zeroize();
        SealedResourceError::Rejected
    })?;
    plaintext.zeroize();
    Ok(decoded)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], SealedResourceError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| SealedResourceError::Rejected)?;
    bytes.try_into().map_err(|_| SealedResourceError::Rejected)
}

fn payload_aad(
    skill_key: &str,
    target: SealedSkillTarget,
    manifest_sha256: &str,
) -> Result<Vec<u8>, SealedResourceError> {
    serde_json::to_vec(&PayloadAad {
        format: PACKAGE_FORMAT,
        version: PACKAGE_FORMAT_VERSION,
        skill_key,
        target,
        manifest_sha256,
    })
    .map_err(|_| SealedResourceError::Unknown)
}

fn manifest_digest(manifest: &PackageManifest) -> Result<String, SealedResourceError> {
    let mut unsigned = manifest.clone();
    unsigned.sha256.clear();
    serde_json::to_vec(&unsigned)
        .map(|bytes| hex_digest(&bytes))
        .map_err(|_| SealedResourceError::Unknown)
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
