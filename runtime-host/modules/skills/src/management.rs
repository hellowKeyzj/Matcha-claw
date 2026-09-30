use std::{collections::BTreeMap, fmt};

use crate::bundle::Bundle;

#[derive(Clone, PartialEq)]
pub enum Command {
    Detail {
        slug: String,
    },
    Config {
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<BTreeMap<String, String>>,
    },
    ClawHubInstall {
        slug: String,
        version: Option<String>,
        force: bool,
    },
    ClawHubUpdate {
        slug: Option<String>,
        all: bool,
    },
    UploadBegin {
        slug: String,
        size: u64,
        sha256: String,
        force: bool,
        idempotency_key: Option<String>,
    },
    UploadChunk {
        upload_id: String,
        offset: u64,
        bytes: Vec<u8>,
    },
    UploadCommit {
        upload_id: String,
        sha256: Option<String>,
    },
    Uninstall {
        skill_key: String,
        slug: Option<String>,
    },
    ImportMarkdown {
        content: String,
    },
    ImportBundle {
        bundle: Bundle,
    },
    Readme {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
    OpenReadme {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
    OpenPath {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Detail(Result<Detail, ReadError>),
    Mutation(MutationOutcome),
    Config {
        outcome: ConfigOutcome,
        invalid_keys: Vec<String>,
    },
    Upload(UploadOutcome),
    Uninstall(RemoveOutcome),
    Import(ImportOutcome),
    Readme(Result<ReadmeReceipt, ReadmeError>),
    OpenPath(Result<OpenPathReceipt, ReadmeError>),
    Unavailable,
    Rejected,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detail {
    pub skill: Option<DetailSkill>,
    pub latest_version: Option<DetailVersion>,
    pub metadata: Option<DetailMetadata>,
    pub owner: Option<DetailOwner>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DetailSkill {
    pub slug: String,
    pub display_name: String,
    pub summary: Option<String>,
    pub tags: BTreeMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DetailVersion {
    pub version: String,
    pub created_at: u64,
    pub changelog: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DetailMetadata {
    pub os: Option<Vec<String>>,
    pub systems: Option<Vec<String>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DetailOwner {
    pub handle: Option<String>,
    pub display_name: Option<String>,
    pub image: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadError {
    Unavailable,
    Rejected,
    Protocol,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Accepted,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigOutcome {
    Accepted,
    Partial,
    Rejected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UploadOutcome {
    Accepted(UploadReceipt),
    Rejected,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReceipt {
    pub upload_id: String,
    pub received_bytes: u64,
    pub expires_at: u64,
    pub sha256: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoveOutcome {
    Removed,
    NotFound,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportOutcome {
    Accepted,
    Rejected,
    Unknown,
}
#[derive(Clone, Eq, PartialEq)]
pub struct ReadmeReceipt {
    pub skill_key: String,
    pub content: String,
    pub file_path: String,
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpenPathReceipt;

impl fmt::Debug for ReadmeReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadmeReceipt([REDACTED])")
    }
}

impl fmt::Debug for OpenPathReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenPathReceipt([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadmeError {
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BundleError {
    Rejected,
    Unknown,
}

impl fmt::Debug for Command {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Detail { slug } => formatter
                .debug_struct("Detail")
                .field("slug", slug)
                .finish(),
            Self::Config {
                skill_key, enabled, ..
            } => formatter
                .debug_struct("Config")
                .field("skill_key", skill_key)
                .field("enabled", enabled)
                .field("private_settings", &"[REDACTED]")
                .finish(),
            Self::ClawHubInstall {
                slug,
                version,
                force,
            } => formatter
                .debug_struct("Install")
                .field("slug", slug)
                .field("version", version)
                .field("force", force)
                .finish(),
            Self::ClawHubUpdate { slug, all } => formatter
                .debug_struct("Update")
                .field("slug", slug)
                .field("all", all)
                .finish(),
            Self::UploadBegin {
                slug,
                size,
                sha256,
                force,
                idempotency_key,
            } => formatter
                .debug_struct("UploadBegin")
                .field("slug", slug)
                .field("size", size)
                .field("sha256", sha256)
                .field("force", force)
                .field("idempotency_key", idempotency_key)
                .finish(),
            Self::UploadChunk {
                upload_id,
                offset,
                bytes,
            } => formatter
                .debug_struct("UploadChunk")
                .field("upload_id", upload_id)
                .field("offset", offset)
                .field("bytes", &format_args!("{} bytes", bytes.len()))
                .finish(),
            Self::UploadCommit { upload_id, sha256 } => formatter
                .debug_struct("UploadCommit")
                .field("upload_id", upload_id)
                .field("sha256", sha256)
                .finish(),
            Self::Uninstall { skill_key, slug } => formatter
                .debug_struct("Uninstall")
                .field("skill_key", skill_key)
                .field("slug", slug)
                .finish(),
            Self::ImportMarkdown { content } => formatter
                .debug_struct("ImportMarkdown")
                .field("content", &format_args!("{} bytes", content.len()))
                .finish(),
            Self::ImportBundle { bundle } => formatter
                .debug_struct("ImportBundle")
                .field("bundle", bundle)
                .finish(),
            Self::Readme {
                skill_key, slug, ..
            } => formatter
                .debug_struct("Readme")
                .field("skill_key", skill_key)
                .field("slug", slug)
                .finish(),
            Self::OpenReadme {
                skill_key, slug, ..
            } => formatter
                .debug_struct("OpenReadme")
                .field("skill_key", skill_key)
                .field("slug", slug)
                .finish(),
            Self::OpenPath {
                skill_key, slug, ..
            } => formatter
                .debug_struct("OpenPath")
                .field("skill_key", skill_key)
                .field("slug", slug)
                .finish(),
        }
    }
}

impl Command {
    pub fn detail(slug: String) -> Result<Self, ()> {
        valid_slug(&slug)
            .then_some(Self::Detail {
                slug: slug.trim().to_owned(),
            })
            .ok_or(())
    }
    pub fn config(
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<BTreeMap<String, String>>,
    ) -> Result<Self, ()> {
        Self::runtime_settings(skill_key, enabled, api_key, env)
    }

    fn runtime_settings(
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<BTreeMap<String, String>>,
    ) -> Result<Self, ()> {
        if enabled.is_none() && api_key.is_none() && env.is_none()
            || !valid_runtime_skill_key(&skill_key)
        {
            return Err(());
        }
        Ok(Self::Config {
            skill_key: skill_key.trim().to_owned(),
            enabled,
            api_key,
            env,
        })
    }
    pub fn clawhub_install(slug: String, version: Option<String>, force: bool) -> Result<Self, ()> {
        Self::registry_install(slug, version, force)
    }

    fn registry_install(slug: String, version: Option<String>, force: bool) -> Result<Self, ()> {
        valid_slug(&slug)
            .then_some(Self::ClawHubInstall {
                slug: slug.trim().to_owned(),
                version: version.map(|v| v.trim().to_owned()),
                force,
            })
            .ok_or(())
    }

    pub fn clawhub_update(slug: Option<String>, all: bool) -> Result<Self, ()> {
        Self::registry_update(slug, all)
    }

    fn registry_update(slug: Option<String>, all: bool) -> Result<Self, ()> {
        (all || slug.as_deref().is_some_and(valid_slug))
            .then_some(Self::ClawHubUpdate {
                slug: slug.map(|v| v.trim().to_owned()),
                all,
            })
            .ok_or(())
    }
    pub fn upload_begin(
        slug: String,
        size: u64,
        sha256: String,
        force: bool,
        idempotency_key: Option<String>,
    ) -> Result<Self, ()> {
        (valid_slug(&slug) && size > 0 && valid_sha256(&sha256))
            .then_some(Self::UploadBegin {
                slug: slug.trim().to_owned(),
                size,
                sha256,
                force,
                idempotency_key,
            })
            .ok_or(())
    }
    pub fn upload_chunk(upload_id: String, offset: u64, bytes: Vec<u8>) -> Result<Self, ()> {
        (!upload_id.trim().is_empty() && !bytes.is_empty())
            .then_some(Self::UploadChunk {
                upload_id,
                offset,
                bytes,
            })
            .ok_or(())
    }
    pub fn upload_commit(upload_id: String, sha256: Option<String>) -> Result<Self, ()> {
        (!upload_id.trim().is_empty() && sha256.as_deref().is_none_or(valid_sha256))
            .then_some(Self::UploadCommit { upload_id, sha256 })
            .ok_or(())
    }
    pub fn uninstall(skill_key: String, slug: Option<String>) -> Result<Self, ()> {
        if !valid_runtime_skill_key(&skill_key)
            || slug.as_deref().is_some_and(|value| !valid_slug(value))
        {
            return Err(());
        }
        Ok(Self::Uninstall {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
        })
    }
    pub fn import_markdown(content: String) -> Result<Self, ()> {
        (!content.is_empty())
            .then_some(Self::ImportMarkdown { content })
            .ok_or(())
    }
    pub fn import_bundle(bundle: Bundle) -> Result<Self, ()> {
        Ok(Self::ImportBundle { bundle })
    }
    pub fn readme(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_runtime_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_runtime_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::Readme {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }

    pub fn open_readme(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_runtime_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_runtime_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::OpenReadme {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }

    pub fn open_path(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_runtime_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_runtime_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::OpenPath {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }
}

fn valid_slug(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_alphanumeric())
}
fn valid_runtime_skill_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::Command;

    #[test]
    fn readme_commands_preserve_public_paths() {
        assert_eq!(
            Command::readme(
                "web-search".into(),
                Some("web-search".into()),
                Some("C:/skills/web-search/SKILL.md".into()),
                Some("C:/skills/web-search".into()),
            ),
            Ok(Command::Readme {
                skill_key: "web-search".into(),
                slug: Some("web-search".into()),
                file_path: Some("C:/skills/web-search/SKILL.md".into()),
                base_dir: Some("C:/skills/web-search".into()),
            })
        );
        assert_eq!(
            Command::open_readme(
                "web-search".into(),
                Some("web-search".into()),
                Some("C:/skills/web-search/SKILL.md".into()),
                Some("C:/skills/web-search".into()),
            ),
            Ok(Command::OpenReadme {
                skill_key: "web-search".into(),
                slug: Some("web-search".into()),
                file_path: Some("C:/skills/web-search/SKILL.md".into()),
                base_dir: Some("C:/skills/web-search".into()),
            })
        );
        assert_eq!(
            Command::open_path(
                "web-search".into(),
                Some("web-search".into()),
                Some("C:/skills/web-search/SKILL.md".into()),
                Some("C:/skills/web-search".into()),
            ),
            Ok(Command::OpenPath {
                skill_key: "web-search".into(),
                slug: Some("web-search".into()),
                file_path: Some("C:/skills/web-search/SKILL.md".into()),
                base_dir: Some("C:/skills/web-search".into()),
            })
        );
    }
}
