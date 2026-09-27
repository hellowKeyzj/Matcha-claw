use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

use crate::{
    api::{
        SealedPackageAuthorizationKey, SealedResourceError, SealedResourceRejectionDetail,
        SealedSkillTarget,
    },
    descriptor::SealedSkillDescriptor,
    domain::{PackageRelativePath, SkillKey},
    package::common::{
        PACKAGE_FORMAT_VERSION, SealedPackageWire, SealedPayloadEntry, hex_digest,
        open_payload_entries, seal_payload_entries_with_cloud_key,
    },
};

const PACKAGE_FORMAT: &str = "matcha-skillpkg";
const MAX_PACKAGE_FILES: usize = 512;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 5 * 1024 * 1024;
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
        let path = PackageRelativePath::parse(path.into()).map_err(|_| rejected("invalid-path"))?;
        let content = content.into();
        if content.len() > MAX_FILE_BYTES {
            return Err(rejected_bytes(
                "file-too-large",
                content.len() as u64,
                MAX_FILE_BYTES as u64,
            ));
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
pub(crate) struct SealedSkillPackageManifest {
    skill_key: SkillKey,
    target: SealedSkillTarget,
    descriptor: SealedSkillDescriptor,
}

impl SealedSkillPackageManifest {
    pub(crate) fn skill_key(&self) -> &SkillKey {
        &self.skill_key
    }

    pub(crate) fn target(&self) -> SealedSkillTarget {
        self.target
    }

    pub(crate) fn descriptor(&self) -> &SealedSkillDescriptor {
        &self.descriptor
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
    ) -> Result<SealSkillPackageReceipt, SealedResourceError> {
        Self::seal_with_cloud_key(skill_key, target, files, None, None)
    }

    pub(crate) fn seal_with_cloud_key(
        skill_key: SkillKey,
        target: SealedSkillTarget,
        files: Vec<SealedSkillFileRequest>,
        cloud_public_key: Option<&str>,
        cloud_key_id: Option<&str>,
    ) -> Result<SealSkillPackageReceipt, SealedResourceError> {
        let files = normalize_files(files)?;
        let descriptor = descriptor_from_files(&files)?;
        let manifest = PackageManifest::from_files(&skill_key, target, &descriptor, &files)
            .map_err(|error| {
                trace_skill_package_error("manifest", files.len(), total_file_bytes(&files), error);
                error
            })?;
        let entries = payload_entries(&files).map_err(|error| {
            trace_skill_package_error("payload-json", files.len(), total_file_bytes(&files), error);
            error
        })?;
        let sealed = seal_payload_entries_with_cloud_key(
            PACKAGE_FORMAT,
            manifest.sha256.as_str(),
            &entries,
            cloud_public_key,
            cloud_key_id,
        )
        .map_err(|error| {
            trace_skill_package_error("seal", files.len(), total_file_bytes(&files), error);
            error
        })?;
        let wire = SealedPackageWire {
            format: PACKAGE_FORMAT.to_owned(),
            version: PACKAGE_FORMAT_VERSION,
            skill_key: Some(skill_key.as_str().to_owned()),
            target: Some(target.as_str().to_owned()),
            manifest_sha256: manifest.sha256.clone(),
            manifest,
            payload: sealed.payload,
            cloud_envelope: sealed.cloud_envelope,
        };
        let bytes = serde_json::to_vec(&wire).map_err(|_| {
            trace_skill_package_error(
                "wire-json",
                files.len(),
                total_file_bytes(&files),
                SealedResourceError::Unknown,
            );
            SealedResourceError::Unknown
        })?;
        Ok(SealSkillPackageReceipt::from_package_bytes(
            bytes,
            sealed.authorization_key,
        ))
    }

    pub(crate) fn open_manifest(
        bytes: &[u8],
    ) -> Result<SealedSkillPackageManifest, SealedResourceError> {
        let (wire, skill_key) = open_wire(bytes)?;
        Ok(SealedSkillPackageManifest {
            skill_key,
            target: wire.manifest.target,
            descriptor: wire.manifest.descriptor.into_descriptor()?,
        })
    }

    pub(crate) fn open(
        bytes: &[u8],
        authorization_key: &SealedPackageAuthorizationKey,
    ) -> Result<Self, SealedResourceError> {
        let (wire, skill_key) = open_wire(bytes)?;
        let payload = open_payload_entries(
            PACKAGE_FORMAT,
            wire.manifest_sha256.as_str(),
            wire.payload,
            authorization_key,
        )?;
        let files = open_payload(payload, &wire.manifest)?;
        let descriptor = wire.manifest.descriptor.into_descriptor()?;
        Ok(Self {
            skill_key,
            target: wire.manifest.target,
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
    authorization_key: SealedPackageAuthorizationKey,
}

impl SealSkillPackageReceipt {
    pub(crate) fn from_package_bytes(
        package_bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Self {
        let package_sha256 = hex_digest(&package_bytes);
        let package_file_name = format!("{}.{}", package_sha256, SEALED_SKILL_PACKAGE_EXTENSION);
        Self {
            package_file_name,
            package_sha256,
            package_bytes,
            authorization_key,
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

    pub(crate) fn authorization_key(&self) -> &SealedPackageAuthorizationKey {
        &self.authorization_key
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
            .field("authorization_key", &"[REDACTED]")
            .finish()
    }
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

    fn into_descriptor(self) -> Result<SealedSkillDescriptor, SealedResourceError> {
        SealedSkillDescriptor::try_new(
            self.name,
            self.description,
            self.user_invocable,
            self.disable_model_invocation,
        )
        .map_err(|_| SealedResourceError::Rejected)
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifestFile {
    path: String,
    size_bytes: u64,
    sha256: String,
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
    if files.is_empty() {
        let error = rejected("empty");
        trace_skill_package_error("normalize-empty", 0, 0, error);
        return Err(error);
    }
    if files.len() > MAX_PACKAGE_FILES {
        let error = rejected_files("too-many-files", files.len(), MAX_PACKAGE_FILES);
        trace_skill_package_error(
            "normalize-too-many-files",
            files.len(),
            request_file_bytes(&files),
            error,
        );
        return Err(error);
    }
    let mut normalized = Vec::with_capacity(files.len());
    let mut total_bytes = 0usize;
    for file in files {
        if normalized
            .iter()
            .any(|existing: &SealedSkillFile| existing.path == file.path)
        {
            let error = rejected("duplicate-path");
            trace_skill_package_error(
                "normalize-duplicate-path",
                normalized.len(),
                total_bytes,
                error,
            );
            return Err(error);
        }
        total_bytes = match total_bytes.checked_add(file.content.len()) {
            Some(total) => total,
            None => {
                let error = rejected("total-overflow");
                trace_skill_package_error(
                    "normalize-total-overflow",
                    normalized.len(),
                    total_bytes,
                    error,
                );
                return Err(error);
            }
        };
        if total_bytes > MAX_PACKAGE_BYTES {
            let error = rejected_bytes(
                "total-too-large",
                total_bytes as u64,
                MAX_PACKAGE_BYTES as u64,
            );
            trace_skill_package_error(
                "normalize-total-too-large",
                normalized.len(),
                total_bytes,
                error,
            );
            return Err(error);
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
        let error = rejected("missing-skill-md");
        trace_skill_package_error(
            "normalize-missing-skill-md",
            normalized.len(),
            total_bytes,
            error,
        );
        return Err(error);
    }
    Ok(normalized)
}

fn open_wire(
    bytes: &[u8],
) -> Result<(SealedPackageWire<PackageManifest>, SkillKey), SealedResourceError> {
    let wire: SealedPackageWire<PackageManifest> =
        serde_json::from_slice(bytes).map_err(|_| SealedResourceError::Rejected)?;
    if wire.format != PACKAGE_FORMAT || wire.version != PACKAGE_FORMAT_VERSION {
        return Err(SealedResourceError::Rejected);
    }
    let skill_key = SkillKey::parse(wire.manifest.skill_key.clone())
        .map_err(|_| SealedResourceError::Rejected)?;
    if wire.manifest_sha256.as_str() != wire.manifest.sha256.as_str()
        || manifest_digest(&wire.manifest)? != wire.manifest_sha256.as_str()
    {
        return Err(SealedResourceError::Rejected);
    }
    Ok((wire, skill_key))
}

fn descriptor_from_files(
    files: &[SealedSkillFile],
) -> Result<SealedSkillDescriptor, SealedResourceError> {
    let manifest_path = PackageRelativePath::skill_manifest();
    let manifest = match files.iter().find(|file| file.path == manifest_path) {
        Some(manifest) => manifest,
        None => {
            let error = rejected("missing-skill-md");
            trace_skill_package_error(
                "descriptor-missing-skill-md",
                files.len(),
                total_file_bytes(files),
                error,
            );
            return Err(error);
        }
    };
    let content = match std::str::from_utf8(&manifest.content) {
        Ok(content) => content,
        Err(_) => {
            let error = rejected("invalid-skill-md");
            trace_skill_package_error(
                "descriptor-non-utf8",
                files.len(),
                total_file_bytes(files),
                error,
            );
            return Err(error);
        }
    };
    SealedSkillDescriptor::parse_skill_manifest(content).map_err(|_| {
        let error = rejected("invalid-skill-md");
        trace_skill_package_error(
            "descriptor-frontmatter",
            files.len(),
            total_file_bytes(files),
            error,
        );
        error
    })
}

fn payload_entries(
    files: &[SealedSkillFile],
) -> Result<Vec<SealedPayloadEntry>, SealedResourceError> {
    files
        .iter()
        .map(|file| {
            Ok(SealedPayloadEntry {
                path: file.path.as_str().to_owned(),
                data_base64: STANDARD.encode(&file.content),
            })
        })
        .collect()
}

fn request_file_bytes(files: &[SealedSkillFileRequest]) -> usize {
    files.iter().map(|file| file.content.len()).sum()
}

fn total_file_bytes(files: &[SealedSkillFile]) -> usize {
    files.iter().map(|file| file.content.len()).sum()
}

fn rejected(reason: &'static str) -> SealedResourceError {
    SealedResourceError::rejected_with(SealedResourceRejectionDetail::new(reason))
}

fn rejected_files(reason: &'static str, files: usize, limit: usize) -> SealedResourceError {
    SealedResourceError::rejected_with(SealedResourceRejectionDetail::files(reason, files, limit))
}

fn rejected_bytes(reason: &'static str, bytes: u64, limit: u64) -> SealedResourceError {
    SealedResourceError::rejected_with(SealedResourceRejectionDetail::bytes(reason, bytes, limit))
}

fn trace_skill_package_error(reason: &str, files: usize, bytes: usize, error: SealedResourceError) {
    eprintln!(
        "[startup-trace] source=sealed-skills-export phase=package detail={} outcome={} files={} bytes={}",
        reason,
        sealed_resource_error_detail(error),
        files,
        bytes
    );
}

fn sealed_resource_error_detail(error: SealedResourceError) -> &'static str {
    match error {
        SealedResourceError::AlreadyExists => "already-exists",
        SealedResourceError::NotFound => "not-found",
        SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => "rejected",
        SealedResourceError::Unknown => "unknown",
    }
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

fn manifest_digest(manifest: &PackageManifest) -> Result<String, SealedResourceError> {
    let mut unsigned = manifest.clone();
    unsigned.sha256.clear();
    serde_json::to_vec(&unsigned)
        .map(|bytes| hex_digest(&bytes))
        .map_err(|_| SealedResourceError::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::common::seal_payload_entries;

    #[test]
    fn sealed_skill_package_encrypts_payload_and_requires_authorization() {
        let secret = "hidden skill payload";
        let receipt = SealedSkillPackage::seal(
            SkillKey::parse("sealed-skill").unwrap(),
            SealedSkillTarget::OpenClaw,
            vec![SealedSkillFileRequest::try_new(
                "SKILL.md",
                format!(
                    "---\nname: Encrypted Skill\ndescription: public descriptor\n---\n{secret}\n"
                ),
            )
            .unwrap()],
        )
        .unwrap();

        assert!(!contains_bytes(receipt.package_bytes(), secret.as_bytes()));
        assert_eq!(
            SealedSkillPackage::open(receipt.package_bytes(), &wrong_authorization_key(&receipt))
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        let package =
            SealedSkillPackage::open(receipt.package_bytes(), receipt.authorization_key()).unwrap();

        assert_eq!(package.descriptor().name(), "Encrypted Skill");
        assert_eq!(
            package
                .file(&PackageRelativePath::skill_manifest())
                .unwrap()
                .content(),
            format!("---\nname: Encrypted Skill\ndescription: public descriptor\n---\n{secret}\n")
                .as_bytes()
        );
    }

    #[test]
    fn open_uses_manifest_descriptor_after_payload_integrity_check() {
        let skill_key = SkillKey::parse("sealed-skill").unwrap();
        let target = SealedSkillTarget::OpenClaw;
        let descriptor =
            SealedSkillDescriptor::try_new("Manifest Skill", "manifest description", None, None)
                .unwrap();
        let files = vec![SealedSkillFile {
            path: PackageRelativePath::skill_manifest(),
            content: b"---\nname: Payload Skill\ndescription: payload description\n---\n".to_vec(),
        }];
        let manifest =
            PackageManifest::from_files(&skill_key, target, &descriptor, &files).unwrap();
        let entries = payload_entries(&files).unwrap();
        let sealed =
            seal_payload_entries(PACKAGE_FORMAT, manifest.sha256.as_str(), &entries).unwrap();
        let manifest_sha256 = manifest.sha256.clone();
        let authorization_key = sealed.authorization_key.clone();
        let bytes = serde_json::to_vec(&SealedPackageWire {
            format: PACKAGE_FORMAT.to_owned(),
            version: PACKAGE_FORMAT_VERSION,
            skill_key: Some(skill_key.as_str().to_owned()),
            target: Some(target.as_str().to_owned()),
            manifest_sha256,
            manifest,
            payload: sealed.payload,
            cloud_envelope: sealed.cloud_envelope,
        })
        .unwrap();

        let package = SealedSkillPackage::open(&bytes, &authorization_key).unwrap();

        assert_eq!(package.descriptor().name(), "Manifest Skill");
        assert_eq!(package.descriptor().description(), "manifest description");
    }

    fn wrong_authorization_key(receipt: &SealSkillPackageReceipt) -> SealedPackageAuthorizationKey {
        let mut bytes = *receipt.authorization_key().as_bytes();
        bytes[0] ^= 1;
        SealedPackageAuthorizationKey::from_bytes(bytes)
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }
}
