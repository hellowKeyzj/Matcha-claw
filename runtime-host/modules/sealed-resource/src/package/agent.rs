use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

use crate::{
    api::{SealedAgentTarget, SealedPackageAuthorizationKey, SealedResourceError},
    domain::{AgentKey, PackageRelativePath},
    package::common::{
        PACKAGE_FORMAT_VERSION, SealedPackageWire, SealedPayloadEntry, hex_digest,
        open_payload_entries, seal_payload_entries_with_cloud_key,
    },
};

const PACKAGE_FORMAT: &str = "matcha-agentpkg";
const MAX_PACKAGE_FILES: usize = 4;
const MAX_FILE_BYTES: usize = 48 * 1024;
const MAX_PACKAGE_BYTES: usize = 48 * 1024;
const SEALED_AGENT_PACKAGE_EXTENSION: &str = "matcha-agentpkg";
const AGENT_BOOTSTRAP_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"];
const REQUIRED_AGENT_BOOTSTRAP_FILE: &str = "AGENTS.md";

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealedAgentFileRequest {
    path: PackageRelativePath,
    content: Vec<u8>,
}

impl SealedAgentFileRequest {
    pub(crate) fn try_new(
        path: impl Into<String>,
        content: impl Into<Vec<u8>>,
    ) -> Result<Self, SealedResourceError> {
        let path = path.into();
        if !is_agent_bootstrap_file(&path) {
            return Err(SealedResourceError::Rejected);
        }
        let path = PackageRelativePath::parse(path).map_err(|_| SealedResourceError::Rejected)?;
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

impl fmt::Debug for SealedAgentFileRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentFileRequest")
            .field("path", &self.path)
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealedAgentFile {
    path: PackageRelativePath,
    content: Vec<u8>,
}

impl SealedAgentFile {
    pub(crate) fn path(&self) -> &PackageRelativePath {
        &self.path
    }

    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }
}

impl fmt::Debug for SealedAgentFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedAgentFile")
            .field("path", &self.path)
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedAgentPackageManifest {
    agent_key: AgentKey,
    target: SealedAgentTarget,
}

impl SealedAgentPackageManifest {
    pub(crate) fn new(agent_key: AgentKey, target: SealedAgentTarget) -> Self {
        Self { agent_key, target }
    }

    pub(crate) fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub(crate) fn target(&self) -> SealedAgentTarget {
        self.target
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedAgentPackage {
    agent_key: AgentKey,
    target: SealedAgentTarget,
    package_sha256: String,
    files: Vec<SealedAgentFile>,
}

impl SealedAgentPackage {
    pub(crate) fn seal(
        agent_key: AgentKey,
        target: SealedAgentTarget,
        files: Vec<SealedAgentFileRequest>,
    ) -> Result<SealAgentPackageReceipt, SealedResourceError> {
        Self::seal_with_cloud_key(agent_key, target, files, None, None)
    }

    pub(crate) fn seal_with_cloud_key(
        agent_key: AgentKey,
        target: SealedAgentTarget,
        files: Vec<SealedAgentFileRequest>,
        cloud_public_key: Option<&str>,
        cloud_key_id: Option<&str>,
    ) -> Result<SealAgentPackageReceipt, SealedResourceError> {
        let files = normalize_files(files)?;
        let manifest = PackageManifest::from_files(&agent_key, target, &files)?;
        let entries = payload_entries(&files)?;
        let sealed = seal_payload_entries_with_cloud_key(
            PACKAGE_FORMAT,
            manifest.sha256.as_str(),
            &entries,
            cloud_public_key,
            cloud_key_id,
        )?;
        let wire = SealedPackageWire {
            format: PACKAGE_FORMAT.to_owned(),
            version: PACKAGE_FORMAT_VERSION,
            skill_key: None,
            target: None,
            manifest_sha256: manifest.sha256.clone(),
            manifest,
            payload: sealed.payload,
            cloud_envelope: sealed.cloud_envelope,
        };
        let bytes = serde_json::to_vec(&wire).map_err(|_| SealedResourceError::Unknown)?;
        Ok(SealAgentPackageReceipt::from_package_bytes(
            bytes,
            sealed.authorization_key,
        ))
    }

    pub(crate) fn open_manifest(
        bytes: &[u8],
    ) -> Result<SealedAgentPackageManifest, SealedResourceError> {
        let (wire, agent_key) = open_wire(bytes)?;
        Ok(SealedAgentPackageManifest {
            agent_key,
            target: wire.manifest.target,
        })
    }

    pub(crate) fn open(
        bytes: &[u8],
        authorization_key: &SealedPackageAuthorizationKey,
    ) -> Result<Self, SealedResourceError> {
        let (wire, agent_key) = open_wire(bytes)?;
        let payload = open_payload_entries(
            PACKAGE_FORMAT,
            wire.manifest_sha256.as_str(),
            wire.payload,
            authorization_key,
        )?;
        let files = open_payload(payload, &wire.manifest)?;
        Ok(Self {
            agent_key,
            target: wire.manifest.target,
            package_sha256: hex_digest(bytes),
            files,
        })
    }

    pub(crate) fn agent_key(&self) -> &AgentKey {
        &self.agent_key
    }

    pub(crate) fn target(&self) -> SealedAgentTarget {
        self.target
    }

    pub(crate) fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub(crate) fn files(&self) -> &[SealedAgentFile] {
        &self.files
    }

    pub(crate) fn file(&self, path: &PackageRelativePath) -> Option<&SealedAgentFile> {
        self.files.iter().find(|file| file.path == *path)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealAgentPackageReceipt {
    package_file_name: String,
    package_sha256: String,
    package_bytes: Vec<u8>,
    authorization_key: SealedPackageAuthorizationKey,
}

impl SealAgentPackageReceipt {
    pub(crate) fn from_package_bytes(
        package_bytes: Vec<u8>,
        authorization_key: SealedPackageAuthorizationKey,
    ) -> Self {
        let package_sha256 = hex_digest(&package_bytes);
        let package_file_name = format!("{}.{}", package_sha256, SEALED_AGENT_PACKAGE_EXTENSION);
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

    pub(crate) fn package_size(&self) -> u64 {
        self.package_bytes.len() as u64
    }

    pub(crate) fn authorization_key(&self) -> &SealedPackageAuthorizationKey {
        &self.authorization_key
    }

    pub(crate) fn into_package_bytes(self) -> Vec<u8> {
        self.package_bytes
    }
}

impl fmt::Debug for SealAgentPackageReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealAgentPackageReceipt")
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
    agent_key: String,
    #[serde(
        deserialize_with = "deserialize_agent_target_code",
        serialize_with = "serialize_agent_target_code"
    )]
    target: SealedAgentTarget,
    files: Vec<PackageManifestFile>,
    sha256: String,
}

impl PackageManifest {
    fn from_files(
        agent_key: &AgentKey,
        target: SealedAgentTarget,
        files: &[SealedAgentFile],
    ) -> Result<Self, SealedResourceError> {
        let mut manifest = Self {
            agent_key: agent_key.as_str().to_owned(),
            target,
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
struct PackageManifestFile {
    path: String,
    size_bytes: u64,
    sha256: String,
}

fn parse_agent_target_code(value: &str) -> Result<SealedAgentTarget, SealedResourceError> {
    match value {
        "openclaw" => Ok(SealedAgentTarget::OpenClaw),
        _ => Err(SealedResourceError::Rejected),
    }
}

fn serialize_agent_target_code<S>(
    target: &SealedAgentTarget,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(target.as_str())
}

fn deserialize_agent_target_code<'de, D>(deserializer: D) -> Result<SealedAgentTarget, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_agent_target_code(&value)
        .map_err(|_| serde::de::Error::custom("invalid sealed agent target"))
}

fn open_wire(
    bytes: &[u8],
) -> Result<(SealedPackageWire<PackageManifest>, AgentKey), SealedResourceError> {
    let wire: SealedPackageWire<PackageManifest> =
        serde_json::from_slice(bytes).map_err(|_| SealedResourceError::Rejected)?;
    if wire.format != PACKAGE_FORMAT || wire.version != PACKAGE_FORMAT_VERSION {
        return Err(SealedResourceError::Rejected);
    }
    let agent_key = AgentKey::parse(wire.manifest.agent_key.clone())
        .map_err(|_| SealedResourceError::Rejected)?;
    if wire.manifest.target != SealedAgentTarget::OpenClaw
        || wire.manifest_sha256.as_str() != wire.manifest.sha256.as_str()
        || manifest_digest(&wire.manifest)? != wire.manifest_sha256.as_str()
    {
        return Err(SealedResourceError::Rejected);
    }
    Ok((wire, agent_key))
}

fn normalize_files(
    files: Vec<SealedAgentFileRequest>,
) -> Result<Vec<SealedAgentFile>, SealedResourceError> {
    if files.is_empty() || files.len() > MAX_PACKAGE_FILES {
        return Err(SealedResourceError::Rejected);
    }
    let mut normalized = Vec::with_capacity(files.len());
    let mut total_bytes = 0usize;
    for file in files {
        if normalized
            .iter()
            .any(|existing: &SealedAgentFile| existing.path == file.path)
        {
            return Err(SealedResourceError::Rejected);
        }
        total_bytes = total_bytes
            .checked_add(file.content.len())
            .ok_or(SealedResourceError::Rejected)?;
        if total_bytes > MAX_PACKAGE_BYTES {
            return Err(SealedResourceError::Rejected);
        }
        normalized.push(SealedAgentFile {
            path: file.path,
            content: file.content,
        });
    }
    normalized.sort_by(|left, right| left.path.cmp(&right.path));
    if !normalized
        .iter()
        .any(|file| file.path.as_str() == REQUIRED_AGENT_BOOTSTRAP_FILE)
    {
        return Err(SealedResourceError::Rejected);
    }
    Ok(normalized)
}

fn payload_entries(
    files: &[SealedAgentFile],
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

fn open_payload(
    payload: Vec<SealedPayloadEntry>,
    manifest: &PackageManifest,
) -> Result<Vec<SealedAgentFile>, SealedResourceError> {
    if payload.len() != manifest.files.len()
        || payload.is_empty()
        || payload.len() > MAX_PACKAGE_FILES
    {
        return Err(SealedResourceError::Rejected);
    }
    let mut files = Vec::with_capacity(payload.len());
    let mut total_bytes = 0usize;
    for entry in payload {
        if !is_agent_bootstrap_file(&entry.path) {
            return Err(SealedResourceError::Rejected);
        }
        let path =
            PackageRelativePath::parse(entry.path).map_err(|_| SealedResourceError::Rejected)?;
        if files
            .iter()
            .any(|existing: &SealedAgentFile| existing.path == path)
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
        files.push(SealedAgentFile { path, content });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if !files
        .iter()
        .any(|file| file.path.as_str() == REQUIRED_AGENT_BOOTSTRAP_FILE)
    {
        return Err(SealedResourceError::Rejected);
    }
    Ok(files)
}

fn manifest_digest(manifest: &PackageManifest) -> Result<String, SealedResourceError> {
    let mut unsigned = manifest.clone();
    unsigned.sha256.clear();
    serde_json::to_vec(&unsigned)
        .map(|bytes| hex_digest(&bytes))
        .map_err(|_| SealedResourceError::Unknown)
}

fn is_agent_bootstrap_file(path: &str) -> bool {
    AGENT_BOOTSTRAP_FILES.contains(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_agent_package_encrypts_payload_and_requires_authorization() {
        let secret = "hidden agent bootstrap";
        let receipt = SealedAgentPackage::seal(
            AgentKey::parse("reviewer").unwrap(),
            SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", secret).unwrap()],
        )
        .unwrap();

        assert!(!contains_bytes(receipt.package_bytes(), secret.as_bytes()));
        assert_eq!(
            SealedAgentPackage::open(receipt.package_bytes(), &wrong_authorization_key(&receipt))
                .unwrap_err(),
            SealedResourceError::Rejected
        );
        let package =
            SealedAgentPackage::open(receipt.package_bytes(), receipt.authorization_key()).unwrap();

        assert_eq!(package.agent_key().as_str(), "reviewer");
        assert_eq!(
            package
                .file(&PackageRelativePath::parse("AGENTS.md").unwrap())
                .unwrap()
                .content(),
            secret.as_bytes()
        );
    }

    fn wrong_authorization_key(receipt: &SealAgentPackageReceipt) -> SealedPackageAuthorizationKey {
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
