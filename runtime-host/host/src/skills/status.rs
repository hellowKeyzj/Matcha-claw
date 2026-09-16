use std::fmt;

pub(crate) use super::status_projection::project;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Available(Catalog),
    Unavailable,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct Catalog {
    pub(crate) entries: Vec<Entry>,
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
pub(crate) struct Entry {
    pub(crate) key: String,
    pub(crate) slug: Option<String>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) enabled: bool,
    pub(crate) selectable: bool,
    pub(crate) eligible: bool,
    pub(crate) blocked_by_allowlist: bool,
    pub(crate) bundled: Option<bool>,
    pub(crate) always: Option<bool>,
    pub(crate) emoji: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) base_dir: Option<String>,
    pub(crate) file_path: Option<String>,
    pub(crate) missing_categories: Vec<RequirementCategory>,
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
            .field("base_dir", &base_dir)
            .field("file_path", &file_path)
            .field("missing_categories", &self.missing_categories)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequirementCategory {
    Binaries,
    AnyBinaries,
    Environment,
    Configuration,
    OperatingSystem,
}
