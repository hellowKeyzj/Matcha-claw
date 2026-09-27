use std::{
    collections::BTreeMap,
    fmt,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use getrandom::fill as random_fill;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

pub use crate::descriptor::SealedSkillDescriptor;
pub use crate::store::{
    SealedAgentCatalog, SealedAgentCatalogEntry, SealedAgentInstallPlan, SealedAgentPackageExport,
    SealedAgentStore, SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillPackageExport,
    SealedSkillStore,
};

const AUTHORIZATION_KEY_BYTES: usize = 32;

#[derive(Clone, Eq, PartialEq)]
pub struct SealedPackageAuthorizationKey([u8; AUTHORIZATION_KEY_BYTES]);

impl SealedPackageAuthorizationKey {
    pub fn from_bytes(bytes: [u8; AUTHORIZATION_KEY_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn try_from_slice(bytes: &[u8]) -> Result<Self, SealedResourceError> {
        bytes
            .try_into()
            .map(Self)
            .map_err(|_| SealedResourceError::Rejected)
    }

    pub fn from_base64(value: &str) -> Result<Self, SealedResourceError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(value.as_bytes())
            .map_err(|_| SealedResourceError::Rejected)?;
        Self::try_from_slice(&bytes)
    }

    pub fn to_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }

    pub(crate) fn generate() -> Result<Self, SealedResourceError> {
        let mut bytes = [0_u8; AUTHORIZATION_KEY_BYTES];
        random_fill(&mut bytes).map_err(|_| SealedResourceError::Unknown)?;
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; AUTHORIZATION_KEY_BYTES] {
        &self.0
    }
}

impl Drop for SealedPackageAuthorizationKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for SealedPackageAuthorizationKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SealedPackageAuthorizationKey")
            .field(&"[REDACTED]")
            .finish()
    }
}

pub struct SealedPackageAuthorizationKeyring {
    entries: Mutex<BTreeMap<String, SealedPackageAuthorizationKeyLease>>,
}

impl SealedPackageAuthorizationKeyring {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn register_authorization_key(
        &self,
        package_sha256: String,
        authorization_key: SealedPackageAuthorizationKey,
        lease_expires_at_ms: u64,
    ) -> Result<(), SealedResourceError> {
        if !is_package_sha256(&package_sha256) || lease_expires_at_ms <= now_millis() {
            return Err(SealedResourceError::Rejected);
        }
        self.entries
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?
            .insert(
                package_sha256,
                SealedPackageAuthorizationKeyLease {
                    authorization_key,
                    lease_expires_at_ms,
                },
            );
        Ok(())
    }

    pub(crate) fn authorization_key(
        &self,
        package_sha256: &str,
    ) -> Result<SealedPackageAuthorizationKey, SealedResourceError> {
        let now = now_millis();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        match entries.get(package_sha256) {
            Some(entry) if entry.lease_expires_at_ms > now => Ok(entry.authorization_key.clone()),
            Some(_) => {
                entries.remove(package_sha256);
                Err(SealedResourceError::Rejected)
            }
            None => Err(SealedResourceError::Rejected),
        }
    }
}

impl Default for SealedPackageAuthorizationKeyring {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for SealedPackageAuthorizationKeyring {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedPackageAuthorizationKeyring")
            .field("entries", &"[REDACTED]")
            .finish()
    }
}

struct SealedPackageAuthorizationKeyLease {
    authorization_key: SealedPackageAuthorizationKey,
    lease_expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SealedCloudPackageType {
    Agent,
    Skill,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealedCloudPackageMetadata {
    source: String,
    package_version_id: String,
    package_type: SealedCloudPackageType,
    package_sha256: String,
    file_name: String,
    #[serde(rename = "installedAt")]
    installed_at_ms: u64,
}

impl SealedCloudPackageMetadata {
    pub fn new(
        package_version_id: String,
        package_type: SealedCloudPackageType,
        package_sha256: String,
        file_name: String,
        installed_at_ms: u64,
    ) -> Result<Self, SealedResourceError> {
        if package_version_id.trim().is_empty()
            || !is_package_sha256(&package_sha256)
            || file_name.trim().is_empty()
        {
            return Err(SealedResourceError::Rejected);
        }
        Ok(Self {
            source: "cloud".to_owned(),
            package_version_id,
            package_type,
            package_sha256,
            file_name,
            installed_at_ms,
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn package_version_id(&self) -> &str {
        &self.package_version_id
    }

    pub fn package_type(&self) -> SealedCloudPackageType {
        self.package_type
    }

    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn installed_at_ms(&self) -> u64 {
        self.installed_at_ms
    }

    pub(crate) fn ensure_matches(
        &self,
        package_type: SealedCloudPackageType,
        package_sha256: &str,
    ) -> Result<(), SealedResourceError> {
        if self.source != "cloud"
            || self.package_type != package_type
            || self.package_sha256 != package_sha256
        {
            return Err(SealedResourceError::Rejected);
        }
        Ok(())
    }
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_package_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedResourceRead {
    content: Vec<u8>,
    metering_binding: Option<SealedResourceMeteringBinding>,
}

impl SealedResourceRead {
    pub(crate) fn new(
        content: Vec<u8>,
        metering_binding: Option<SealedResourceMeteringBinding>,
    ) -> Self {
        Self {
            content,
            metering_binding,
        }
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub fn metering_binding(&self) -> Option<&SealedResourceMeteringBinding> {
        self.metering_binding.as_ref()
    }
}

impl fmt::Debug for SealedResourceRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedResourceRead")
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .field("metering_binding", &self.metering_binding)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedResourceMeteringBinding(String);

impl SealedResourceMeteringBinding {
    pub(crate) fn openclaw(
        kind: SealedResourceMeteringKind,
        key: &str,
        package_sha256: &str,
        usage: SealedResourceMeteringUse,
    ) -> Result<Self, SealedResourceError> {
        let payload = SealedResourceMeteringPayload {
            v: 1,
            kind,
            runtime: "openclaw",
            package_sha256,
            key,
            usage,
        };
        serde_json::to_vec(&payload)
            .map(|bytes| Self(format!("m1.{}", URL_SAFE_NO_PAD.encode(bytes))))
            .map_err(|_| SealedResourceError::Unknown)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SealedResourceMeteringKind {
    Agent,
    Skill,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SealedResourceMeteringUse {
    Session,
    Turn,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedResourceMeteringPayload<'a> {
    v: u8,
    kind: SealedResourceMeteringKind,
    runtime: &'a str,
    package_sha256: &'a str,
    key: &'a str,
    #[serde(rename = "use")]
    usage: SealedResourceMeteringUse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedSkillTarget {
    OpenClaw,
}

impl SealedSkillTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedAgentTarget {
    OpenClaw,
}

impl SealedAgentTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SealedResourceRejectionDetail {
    reason: &'static str,
    files: Option<usize>,
    bytes: Option<u64>,
    limit: Option<u64>,
}

impl SealedResourceRejectionDetail {
    pub const fn new(reason: &'static str) -> Self {
        Self {
            reason,
            files: None,
            bytes: None,
            limit: None,
        }
    }

    pub const fn files(reason: &'static str, files: usize, limit: usize) -> Self {
        Self {
            reason,
            files: Some(files),
            bytes: None,
            limit: Some(limit as u64),
        }
    }

    pub const fn bytes(reason: &'static str, bytes: u64, limit: u64) -> Self {
        Self {
            reason,
            files: None,
            bytes: Some(bytes),
            limit: Some(limit),
        }
    }

    pub fn reason(self) -> &'static str {
        self.reason
    }

    pub fn message(self) -> String {
        match (self.reason, self.files, self.bytes, self.limit) {
            ("too-many-files", Some(files), _, Some(limit)) => {
                format!("Skill package contains {files} files; maximum is {limit}.")
            }
            ("total-too-large", _, Some(bytes), Some(limit)) => {
                format!("Skill package is {bytes} bytes; maximum is {limit} bytes.")
            }
            ("file-too-large", _, Some(bytes), Some(limit)) => {
                format!("Skill package file is {bytes} bytes; maximum is {limit} bytes.")
            }
            ("missing-skill-md", _, _, _) => "Skill package is missing SKILL.md.".to_owned(),
            ("invalid-skill-md", _, _, _) => "Skill package SKILL.md is invalid.".to_owned(),
            (reason, _, _, _) => format!("Skill package was rejected: {reason}."),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedResourceError {
    AlreadyExists,
    NotFound,
    Rejected,
    RejectedWith(SealedResourceRejectionDetail),
    Unknown,
}

impl SealedResourceError {
    pub const fn rejected() -> Self {
        Self::Rejected
    }

    pub const fn rejected_with(detail: SealedResourceRejectionDetail) -> Self {
        Self::RejectedWith(detail)
    }

    pub const fn rejection_detail(self) -> Option<SealedResourceRejectionDetail> {
        match self {
            Self::RejectedWith(detail) => Some(detail),
            _ => None,
        }
    }
}
