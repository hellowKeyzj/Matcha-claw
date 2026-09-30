use std::{future::Future, path::PathBuf, pin::Pin};

use crate::{bundle, install, management, status};

pub type SkillsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudPackageMetadata {
    package_version_id: String,
    package_type: String,
    package_sha256: Option<String>,
    file_name: Option<String>,
}

impl CloudPackageMetadata {
    pub fn new(
        package_version_id: String,
        package_type: String,
        package_sha256: Option<String>,
        file_name: Option<String>,
    ) -> Self {
        Self {
            package_version_id,
            package_type,
            package_sha256,
            file_name,
        }
    }

    pub fn package_version_id(&self) -> &str {
        &self.package_version_id
    }

    pub fn package_type(&self) -> &str {
        &self.package_type
    }

    pub fn package_sha256(&self) -> Option<&str> {
        self.package_sha256.as_deref()
    }

    pub fn file_name(&self) -> Option<&str> {
        self.file_name.as_deref()
    }
}

pub trait SkillRuntimeOps: Send + Sync {
    fn installed_skill_names<'a>(&'a self) -> SkillsFuture<'a, Option<Vec<String>>>;

    fn install_clawhub_skill<'a>(
        &'a self,
        command: install::Command,
    ) -> SkillsFuture<'a, install::Outcome>;

    fn skill_status<'a>(&'a self) -> SkillsFuture<'a, status::Outcome>;

    fn manage_skills<'a>(
        &'a self,
        command: management::Command,
    ) -> SkillsFuture<'a, management::Outcome>;

    fn skill_bundles<'a>(&'a self, command: bundle::Command) -> SkillsFuture<'a, bundle::Outcome>;
}

pub trait SkillsPort: Send + Sync {
    fn install_clawhub_skill<'a>(
        &'a self,
        command: install::Command,
    ) -> SkillsFuture<'a, Result<install::Outcome, ()>>;

    fn skill_status<'a>(&'a self) -> SkillsFuture<'a, Result<status::Outcome, ()>>;

    fn manage_skills<'a>(
        &'a self,
        command: management::Command,
    ) -> SkillsFuture<'a, Result<management::Outcome, ()>>;

    fn skill_bundles<'a>(
        &'a self,
        command: bundle::Command,
    ) -> SkillsFuture<'a, Result<bundle::Outcome, ()>>;
}

pub trait ClawHubSearchPort: Send + Sync {
    fn search<'a>(
        &'a self,
        query: Option<String>,
        limit: u16,
    ) -> SkillsFuture<'a, Result<Vec<ClawHubSearchResult>, ()>>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawHubSearchResult {
    slug: String,
    name: String,
    description: String,
    version: String,
    author: Option<String>,
    downloads: Option<u64>,
    stars: Option<u64>,
}

impl ClawHubSearchResult {
    pub fn new(
        slug: String,
        name: String,
        description: String,
        version: String,
        author: Option<String>,
        downloads: Option<u64>,
        stars: Option<u64>,
    ) -> Self {
        Self {
            slug,
            name,
            description,
            version,
            author,
            downloads,
            stars,
        }
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn author(&self) -> Option<&str> {
        self.author.as_deref()
    }

    pub const fn downloads(&self) -> Option<u64> {
        self.downloads
    }

    pub const fn stars(&self) -> Option<u64> {
        self.stars
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedSkillPackageExport {
    skill_key: String,
    file_name: String,
    package_sha256: String,
    package_bytes: Vec<u8>,
}

impl SealedSkillPackageExport {
    pub fn new(
        skill_key: String,
        file_name: String,
        package_sha256: String,
        package_bytes: Vec<u8>,
    ) -> Self {
        Self {
            skill_key,
            file_name,
            package_sha256,
            package_bytes,
        }
    }

    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }
    pub fn file_name(&self) -> &str {
        &self.file_name
    }
    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }
    pub fn into_package_bytes(self) -> Vec<u8> {
        self.package_bytes
    }
}

impl std::fmt::Debug for SealedSkillPackageExport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SealedSkillPackageExport")
            .field("skill_key", &self.skill_key)
            .field("size_bytes", &self.package_bytes.len())
            .finish_non_exhaustive()
    }
}

pub trait SealedSkillStorePort: Send + Sync {
    fn sealed_catalog(&self) -> Result<SealedSkillCatalog, SealedSkillError>;

    fn export_sealed_skill_package(
        &self,
        skill_key: String,
    ) -> Result<SealedSkillCatalogEntry, SealedSkillError>;

    fn export_cloud_sealed_skill_package(
        &self,
        skill_key: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<SealedSkillPackageExport, SealedSkillError>;

    fn install_sealed_skill(
        &self,
        package_path: PathBuf,
        cloud_metadata: Option<CloudPackageMetadata>,
    ) -> Result<SealedSkillCatalogEntry, SealedSkillError>;

    fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: String,
        path: String,
        expected_package_sha256: Option<&str>,
    ) -> Result<SealedResourceRead, SealedSkillError>;

    fn remove_sealed_skill(&self, skill_key: String) -> Result<bool, SealedSkillError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillCatalog {
    entries: Vec<SealedSkillCatalogEntry>,
}

impl SealedSkillCatalog {
    pub fn new(entries: Vec<SealedSkillCatalogEntry>) -> Self {
        Self { entries }
    }

    pub fn entries(&self) -> &[SealedSkillCatalogEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillCatalogEntry {
    skill_key: String,
    name: String,
    description: String,
    runtime_target: &'static str,
}

impl SealedSkillCatalogEntry {
    pub fn new(
        skill_key: String,
        name: String,
        description: String,
        runtime_target: &'static str,
    ) -> Self {
        Self {
            skill_key,
            name,
            description,
            runtime_target,
        }
    }

    pub fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn runtime_target(&self) -> &'static str {
        self.runtime_target
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedResourceRead {
    content: Vec<u8>,
    metering_binding: Option<String>,
    package_sha256: String,
}

impl SealedResourceRead {
    pub fn new(content: Vec<u8>, metering_binding: Option<String>, package_sha256: String) -> Self {
        Self {
            content,
            metering_binding,
            package_sha256,
        }
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub fn metering_binding(&self) -> Option<&str> {
        self.metering_binding.as_deref()
    }

    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }
}

impl std::fmt::Debug for SealedResourceRead {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SealedResourceRead")
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .field("metering_binding", &self.metering_binding)
            .field("package_sha256", &self.package_sha256)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillRejectionDetail {
    reason: String,
    message: String,
}

impl SealedSkillRejectionDetail {
    pub fn new(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            message: message.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SealedSkillError {
    AlreadyExists,
    NotFound,
    PackageChanged,
    Rejected,
    RejectedWith(SealedSkillRejectionDetail),
    Unknown,
}

impl SealedSkillError {
    pub const fn rejected() -> Self {
        Self::Rejected
    }

    pub fn rejected_with(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self::RejectedWith(SealedSkillRejectionDetail::new(reason, message))
    }

    pub fn rejection_detail(&self) -> Option<&SealedSkillRejectionDetail> {
        match self {
            Self::RejectedWith(detail) => Some(detail),
            _ => None,
        }
    }
}
