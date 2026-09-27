use std::fmt;

pub use crate::projection::status::project;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
    Available(Catalog),
    Unavailable,
}

#[derive(Clone, Eq, PartialEq)]
pub struct Catalog {
    pub entries: Vec<Entry>,
}

impl fmt::Debug for Catalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Catalog")
            .field("entries", &self.entries)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct Entry {
    pub key: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub selectable: bool,
    pub eligible: bool,
    pub blocked_by_allowlist: bool,
    pub bundled: Option<bool>,
    pub always: Option<bool>,
    pub emoji: Option<String>,
    pub source: Option<String>,
    pub uninstallable: bool,
    pub base_dir: Option<String>,
    pub file_path: Option<String>,
    pub missing_categories: Vec<RequirementCategory>,
}

impl fmt::Debug for Entry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let base_dir = self.base_dir.as_ref().map(|_| "[REDACTED]");
        let file_path = self.file_path.as_ref().map(|_| "[REDACTED]");
        formatter
            .debug_struct("Entry")
            .field("key", &self.key)
            .field("slug", &self.slug)
            .field("name", &self.name)
            .field("description", &self.description)
            .field("enabled", &self.enabled)
            .field("selectable", &self.selectable)
            .field("eligible", &self.eligible)
            .field("blocked_by_allowlist", &self.blocked_by_allowlist)
            .field("bundled", &self.bundled)
            .field("always", &self.always)
            .field("emoji", &self.emoji)
            .field("source", &self.source)
            .field("uninstallable", &self.uninstallable)
            .field("base_dir", &base_dir)
            .field("file_path", &file_path)
            .field("missing_categories", &self.missing_categories)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequirementCategory {
    Binaries,
    AnyBinaries,
    Environment,
    Configuration,
    OperatingSystem,
}
